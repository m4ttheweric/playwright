import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

import { crxIdFromPublicKey, extensionIdFromCrxId, packCrx, publicKeyDer, updateManifest } from './crx.mjs';

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixedTimestamp = new Date('1980-01-01T00:00:00.000Z');
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const defaultReleaseRepository = 'm4ttheweric/playwright';
const updateManifestFile = 'update.xml';
const relevantSourcePaths = [
  'LICENSE',
  'NOTICE',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'packages',
  'utils',
];

function parseArguments(argv) {
  let productVersion;
  let outDir;
  let crxKeyPath;
  let releaseRepository;
  for (let index = 0; index < argv.length; ++index) {
    const argument = argv[index];
    if (argument === '--version')
      productVersion = argv[++index];
    else if (argument === '--out-dir')
      outDir = argv[++index];
    else if (argument === '--crx-key')
      crxKeyPath = argv[++index];
    else if (argument === '--release-repository')
      releaseRepository = argv[++index];
    else
      throw new Error(`Unknown argument: ${argument}`);
  }
  if (!productVersion || !versionPattern.test(productVersion))
    throw new Error('Expected --version to be a semver value.');
  if (!outDir)
    throw new Error('Expected --out-dir.');
  return { productVersion, outDir: path.resolve(outDir), crxKeyPath, releaseRepository };
}

// The signing key is never in the tree: it lives outside the repository and is
// read at pack time only. Losing it means losing the extension id, so the
// builder refuses to fall back to an unsigned release rather than quietly
// shipping a set Chrome cannot update.
export function resolveCrxKeyPath(crxKeyPath) {
  const resolved = crxKeyPath
    ?? process.env.FAST_BROWSER_CRX_KEY
    ?? path.join(os.homedir(), '.fast-browser', 'keys', 'crx-signing.pem');
  if (!fs.existsSync(resolved)) {
    throw new Error(
        `CRX signing key not found at ${resolved}. `
        + 'Pass --crx-key or set FAST_BROWSER_CRX_KEY.');
  }
  return resolved;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8', shell: false });
  if (result.error)
    throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`.trim());
  return result;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function extensionIdFromManifestKey(key) {
  const alphabet = 'abcdefghijklmnop';
  const digest = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16);
  return [...digest].map(byte => alphabet[byte >> 4] + alphabet[byte & 15]).join('');
}

function sortedEntries(directory, includeDirectories) {
  const entries = [];
  const visit = current => {
    if (includeDirectories || current !== directory)
      entries.push(path.relative(directory, current));
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory())
        visit(child);
      else
        entries.push(path.relative(directory, child));
    }
  };
  visit(directory);
  return entries;
}

function normalizeMetadata(directory) {
  for (const relativePath of sortedEntries(directory, true)) {
    const file = relativePath ? path.join(directory, relativePath) : directory;
    const stat = fs.lstatSync(file);
    fs.utimesSync(file, fixedTimestamp, fixedTimestamp);
    if (stat.isDirectory())
      fs.chmodSync(file, 0o755);
    else if (!stat.isSymbolicLink())
      fs.chmodSync(file, stat.mode & 0o111 ? 0o755 : 0o644);
  }
}

function copyLauncher(repositoryRoot, destination, productVersion) {
  const launcherSource = path.join(repositoryRoot, 'packages', 'fast-browser-mcp');
  fs.cpSync(launcherSource, destination, { recursive: true });
  const packageJsonPath = path.join(destination, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  packageJson.version = productVersion;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function copyPlaywrightCorePayload(repositoryRoot, destination, stagingDir) {
  const coreSource = path.join(repositoryRoot, 'packages', 'playwright-core');
  const packageDir = path.join(stagingDir, 'npm-pack');
  const unpackDir = path.join(stagingDir, 'npm-unpack');
  try {
    fs.mkdirSync(packageDir);
    const packed = run('npm', ['pack', '--json', '--pack-destination', packageDir], { cwd: coreSource });
    const [{ filename }] = JSON.parse(packed.stdout);
    const archive = path.join(packageDir, filename);
    fs.mkdirSync(unpackDir);
    run('tar', ['-xzf', archive, '-C', unpackDir]);
    fs.renameSync(path.join(unpackDir, 'package'), destination);
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
    fs.rmSync(unpackDir, { recursive: true, force: true });
  }
}

function createRuntimeArchive(runtimeRoot, archive) {
  const archiveRoot = path.basename(runtimeRoot);
  const entries = [archiveRoot, ...sortedEntries(runtimeRoot, false).map(entry => path.join(archiveRoot, entry))];
  const tarFile = path.join(path.dirname(runtimeRoot), 'runtime.tar');
  run('tar', [
    '--format', 'ustar',
    '--uid', '0',
    '--gid', '0',
    '--uname', 'root',
    '--gname', 'root',
    '--no-recursion',
    '-cf', tarFile,
    '-C', path.dirname(runtimeRoot),
    ...entries,
  ]);
  run('gzip', ['-n', '-f', tarFile]);
  fs.renameSync(`${tarFile}.gz`, archive);
}

function createExtensionArchive(extensionDir, archive) {
  const files = sortedEntries(extensionDir, false);
  run('zip', ['-X', '-q', '-D', archive, ...files], {
    cwd: extensionDir,
    env: { ...process.env, TZ: 'UTC' },
  });
}

function sourceCommit(repositoryRoot) {
  return run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }).stdout.trim();
}

export function resolveOutputDirectory(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  return fs.realpathSync(outDir);
}

export function createArtifactStagingDirectory(outDir) {
  const physicalOutDir = resolveOutputDirectory(outDir);
  return fs.mkdtempSync(path.join(physicalOutDir, '.fast-browser-artifacts-'));
}

function assertCleanRelevantSource(repositoryRoot) {
  const status = run('git', [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    ...relevantSourcePaths,
  ], { cwd: repositoryRoot }).stdout;
  const changes = status.split('\0').filter(Boolean);
  if (changes.length)
    throw new Error(`Cannot build Fast Browser artifacts from dirty relevant source:\n${changes.join('\n')}`);
}

export function verifyRepositoryProvenance(repositoryRoot, expectedCommit) {
  assertCleanRelevantSource(repositoryRoot);
  const actualCommit = sourceCommit(repositoryRoot);
  if (actualCommit !== expectedCommit)
    throw new Error(`Source commit changed during Fast Browser build: ${expectedCommit} -> ${actualCommit}`);
}

export function prepareRepositoryForArtifactBuild(repositoryRoot, dependencies = {}) {
  assertCleanRelevantSource(repositoryRoot);
  const commit = sourceCommit(repositoryRoot);
  fs.rmSync(path.join(repositoryRoot, 'packages', 'playwright-core', 'lib'), { recursive: true, force: true });
  fs.rmSync(path.join(repositoryRoot, 'packages', 'extension', 'dist'), { recursive: true, force: true });
  const runBuild = dependencies.runBuild ?? (buildRoot => {
    run(process.execPath, ['utils/build/build.js'], { cwd: buildRoot, stdio: 'inherit' });
  });
  runBuild(repositoryRoot);
  verifyRepositoryProvenance(repositoryRoot, commit);
  return commit;
}

export function publishReleaseSet(stagedFiles, outputFiles, dependencies = {}) {
  if (stagedFiles.length !== outputFiles.length)
    throw new Error('Staged and output release file counts must match.');
  const renameSync = dependencies.renameSync ?? fs.renameSync;
  const backupDir = path.join(path.dirname(stagedFiles[0]), 'previous-release');
  fs.mkdirSync(backupDir);
  const backups = [];
  const promoted = [];
  const roles = ['runtime', 'extension', 'crx', 'update', 'manifest'];
  try {
    for (let index = 0; index < outputFiles.length; ++index) {
      const outputFile = outputFiles[index];
      if (!fs.existsSync(outputFile))
        continue;
      const backupFile = path.join(backupDir, `${index}-${path.basename(outputFile)}`);
      renameSync(outputFile, backupFile);
      backups.push({ outputFile, backupFile });
      dependencies.onTransactionBoundary?.(`backup:${roles[index]}`);
    }
    for (let index = 0; index < stagedFiles.length; ++index) {
      renameSync(stagedFiles[index], outputFiles[index]);
      promoted.push(outputFiles[index]);
      dependencies.onTransactionBoundary?.(`promote:${roles[index]}`);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const outputFile of promoted.reverse()) {
      try {
        fs.rmSync(outputFile, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const { outputFile, backupFile } of backups.reverse()) {
      try {
        renameSync(backupFile, outputFile);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      const recoveryDirectory = path.dirname(stagedFiles[0]);
      const aggregate = new AggregateError(
          [error, ...rollbackErrors],
          `Fast Browser release rollback failed. Recovery files preserved at ${recoveryDirectory}`);
      aggregate.recoveryDirectory = recoveryDirectory;
      throw aggregate;
    }
    throw error;
  }
}

export function packagePreparedArtifacts({
  productVersion,
  outDir,
  repositoryRoot,
  sourceCommit: commit,
  crxKeyPath,
  releaseRepository = defaultReleaseRepository,
}, dependencies = {}) {
  const extensionDir = path.join(repositoryRoot, 'packages', 'extension', 'dist');
  const extensionManifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  if (typeof extensionManifest.key !== 'string')
    throw new Error('The extension manifest must contain a public key.');

  // The packed CRX takes its id from the signing key while an unpacked load
  // takes it from the manifest `key`. They are the same extension only while
  // those two agree, and a mismatch is invisible until Chrome installs the
  // pair side by side, so it is a build failure here.
  const crxKey = fs.readFileSync(resolveCrxKeyPath(crxKeyPath), 'utf8');
  const signingId = extensionIdFromCrxId(crxIdFromPublicKey(publicKeyDer(crxKey)));
  const manifestId = extensionIdFromManifestKey(extensionManifest.key);
  if (signingId !== manifestId) {
    throw new Error(
        `CRX signing key derives extension id ${signingId}, `
        + `but packages/extension/manifest.json declares ${manifestId}.`);
  }

  outDir = resolveOutputDirectory(outDir);
  const stagingDir = createArtifactStagingDirectory(outDir);
  let preserveStaging = false;
  try {
    const runtimeRoot = path.join(stagingDir, 'fast-browser-mcp');
    const stagedExtensionDir = path.join(stagingDir, 'extension');
    copyLauncher(repositoryRoot, runtimeRoot, productVersion);
    copyPlaywrightCorePayload(repositoryRoot, path.join(runtimeRoot, 'playwright-core'), stagingDir);
    fs.cpSync(extensionDir, stagedExtensionDir, { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, 'LICENSE'), path.join(stagedExtensionDir, 'LICENSE'));
    fs.copyFileSync(path.join(repositoryRoot, 'NOTICE'), path.join(stagedExtensionDir, 'NOTICE'));
    fs.copyFileSync(
        path.join(repositoryRoot, 'packages', 'extension', 'ThirdPartyNotices.txt'),
        path.join(stagedExtensionDir, 'ThirdPartyNotices.txt'));
    normalizeMetadata(runtimeRoot);
    normalizeMetadata(stagedExtensionDir);

    const runtimeFile = `fast-browser-mcp-${productVersion}.tar.gz`;
    const extensionFile = `fast-browser-extension-${productVersion}.zip`;
    const crxFile = `fast-browser-extension-${productVersion}.crx`;
    const releaseFile = `fast-browser-release-${productVersion}.json`;
    const stagedRuntimeArchive = path.join(stagingDir, runtimeFile);
    const stagedExtensionArchive = path.join(stagingDir, extensionFile);
    const stagedCrx = path.join(stagingDir, crxFile);
    const stagedUpdateManifest = path.join(stagingDir, updateManifestFile);
    const stagedReleaseManifest = path.join(stagingDir, releaseFile);
    createRuntimeArchive(runtimeRoot, stagedRuntimeArchive);
    createExtensionArchive(stagedExtensionDir, stagedExtensionArchive);
    fs.writeFileSync(stagedCrx, packCrx({
      archive: fs.readFileSync(stagedExtensionArchive),
      privateKeyPem: crxKey,
    }));
    const releaseBase = `https://github.com/${releaseRepository}/releases/download/fast-browser-v${productVersion}`;
    fs.writeFileSync(stagedUpdateManifest, updateManifest({
      appId: manifestId,
      codebase: `${releaseBase}/${crxFile}`,
      version: extensionManifest.version,
    }));
    const verifyProvenance = dependencies.verifyProvenance ?? verifyRepositoryProvenance;
    verifyProvenance(repositoryRoot, commit);

    const release = {
      schemaVersion: 1,
      productVersion,
      sourceCommit: commit,
      protocolVersion: 2,
      runtime: {
        file: runtimeFile,
        sha256: sha256(stagedRuntimeArchive),
        node: '>=20',
      },
      extension: {
        file: extensionFile,
        sha256: sha256(stagedExtensionArchive),
        id: manifestId,
        version: extensionManifest.version,
        crx: {
          file: crxFile,
          sha256: sha256(stagedCrx),
        },
      },
    };
    fs.writeFileSync(stagedReleaseManifest, `${JSON.stringify(release, null, 2)}\n`);
    publishReleaseSet(
        [stagedRuntimeArchive, stagedExtensionArchive, stagedCrx, stagedUpdateManifest, stagedReleaseManifest],
        [runtimeFile, extensionFile, crxFile, updateManifestFile, releaseFile].map(file => path.join(outDir, file)),
        {
          renameSync: dependencies.renameSync,
          onTransactionBoundary: dependencies.onTransactionBoundary,
        });
    console.log(`Built ${runtimeFile}, ${extensionFile}, ${crxFile} and ${updateManifestFile}`);
  } catch (error) {
    preserveStaging = error?.recoveryDirectory === stagingDir;
    throw error;
  } finally {
    if (!preserveStaging)
      fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function buildArtifacts({ productVersion, outDir, crxKeyPath, releaseRepository }) {
  const repositoryRoot = defaultRepositoryRoot;
  // Resolved before the build so a missing key fails in seconds rather than
  // after a full playwright-core compile.
  resolveCrxKeyPath(crxKeyPath);
  const commit = prepareRepositoryForArtifactBuild(repositoryRoot);
  packagePreparedArtifacts({
    productVersion,
    outDir,
    repositoryRoot,
    sourceCommit: commit,
    crxKeyPath,
    releaseRepository,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  buildArtifacts(parseArguments(process.argv.slice(2)));
