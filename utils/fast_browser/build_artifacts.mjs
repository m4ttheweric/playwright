import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixedTimestamp = new Date('1980-01-01T00:00:00.000Z');
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

function parseArguments(argv) {
  let productVersion;
  let outDir;
  for (let index = 0; index < argv.length; ++index) {
    const argument = argv[index];
    if (argument === '--version')
      productVersion = argv[++index];
    else if (argument === '--out-dir')
      outDir = argv[++index];
    else
      throw new Error(`Unknown argument: ${argument}`);
  }
  if (!productVersion || !versionPattern.test(productVersion))
    throw new Error('Expected --version to be a semver value.');
  if (!outDir)
    throw new Error('Expected --out-dir.');
  return { productVersion, outDir: path.resolve(outDir) };
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

function copyLauncher(destination, productVersion) {
  const launcherSource = path.join(repositoryRoot, 'packages', 'fast-browser-mcp');
  fs.cpSync(launcherSource, destination, { recursive: true });
  const packageJsonPath = path.join(destination, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  packageJson.version = productVersion;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function copyPlaywrightCorePayload(destination, stagingDir) {
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

function sourceCommit() {
  return run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }).stdout.trim();
}

function promote(stagedFile, outputFile) {
  fs.renameSync(stagedFile, outputFile);
}

function buildArtifacts({ productVersion, outDir }) {
  const extensionDir = path.join(repositoryRoot, 'packages', 'extension', 'dist');
  const extensionManifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  if (typeof extensionManifest.key !== 'string')
    throw new Error('The extension manifest must contain a public key.');

  fs.mkdirSync(outDir, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(path.dirname(outDir), `.${path.basename(outDir)}-fast-browser-artifacts-`));
  try {
    const runtimeRoot = path.join(stagingDir, 'fast-browser-mcp');
    const stagedExtensionDir = path.join(stagingDir, 'extension');
    copyLauncher(runtimeRoot, productVersion);
    copyPlaywrightCorePayload(path.join(runtimeRoot, 'playwright-core'), stagingDir);
    fs.cpSync(extensionDir, stagedExtensionDir, { recursive: true });
    normalizeMetadata(runtimeRoot);
    normalizeMetadata(stagedExtensionDir);

    const runtimeFile = `fast-browser-mcp-${productVersion}.tar.gz`;
    const extensionFile = `fast-browser-extension-${productVersion}.zip`;
    const releaseFile = `fast-browser-release-${productVersion}.json`;
    const runtimeArchive = path.join(outDir, runtimeFile);
    const extensionArchive = path.join(outDir, extensionFile);
    const stagedRuntimeArchive = path.join(stagingDir, runtimeFile);
    const stagedExtensionArchive = path.join(stagingDir, extensionFile);
    const releaseManifest = path.join(outDir, releaseFile);
    const stagedReleaseManifest = path.join(stagingDir, releaseFile);
    createRuntimeArchive(runtimeRoot, stagedRuntimeArchive);
    createExtensionArchive(stagedExtensionDir, stagedExtensionArchive);

    const release = {
      schemaVersion: 1,
      productVersion,
      sourceCommit: sourceCommit(),
      protocolVersion: 2,
      runtime: {
        file: runtimeFile,
        sha256: sha256(stagedRuntimeArchive),
        node: '>=20',
      },
      extension: {
        file: extensionFile,
        sha256: sha256(stagedExtensionArchive),
        id: extensionIdFromManifestKey(extensionManifest.key),
        version: extensionManifest.version,
      },
    };
    fs.writeFileSync(stagedReleaseManifest, `${JSON.stringify(release, null, 2)}\n`);
    promote(stagedRuntimeArchive, runtimeArchive);
    promote(stagedExtensionArchive, extensionArchive);
    promote(stagedReleaseManifest, releaseManifest);
    console.log(`Built ${runtimeFile} and ${extensionFile}`);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

buildArtifacts(parseArguments(process.argv.slice(2)));
