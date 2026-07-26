/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse } from 'yaml';
import { test, expect, parseResponse } from './fixtures';

const rootDir = path.resolve(__dirname, '../..');
const builderUrl = pathToFileURL(path.join(rootDir, 'utils/fast_browser/build_artifacts.mjs')).href;

type ArtifactBuilder = {
  buildArtifacts: (options: { productVersion: string, outDir: string }) => void,
  packagePreparedArtifacts: (
    options: { productVersion: string, outDir: string, repositoryRoot: string, sourceCommit: string },
    dependencies?: {
      renameSync?: typeof fs.renameSync,
      onTransactionBoundary?: (boundary: string) => void,
      verifyProvenance?: (repositoryRoot: string, sourceCommit: string) => void,
    },
  ) => void,
  createArtifactStagingDirectory: (outDir: string) => string,
  prepareRepositoryForArtifactBuild: (
    repositoryRoot: string,
    dependencies?: { runBuild?: (repositoryRoot: string) => void },
  ) => string,
  resolveOutputDirectory: (outDir: string) => string,
  verifyRepositoryProvenance: (repositoryRoot: string, sourceCommit: string) => void,
};

async function loadArtifactBuilder(): Promise<ArtifactBuilder> {
  return await import(builderUrl) as ArtifactBuilder;
}

async function buildArtifactsForTesting(outDir: string, version: string, dependencies?: {
  renameSync?: typeof fs.renameSync,
  onTransactionBoundary?: (boundary: string) => void,
  verifyProvenance?: (repositoryRoot: string, sourceCommit: string) => void,
}) {
  const builder = await loadArtifactBuilder();
  builder.packagePreparedArtifacts({
    productVersion: version,
    outDir,
    repositoryRoot: rootDir,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim(),
  }, {
    ...dependencies,
    verifyProvenance: dependencies?.verifyProvenance ?? (() => {}),
  });
}

async function buildArtifacts(outDir: string, version: string) {
  await buildArtifactsForTesting(outDir, version);
}

function createCommittedArtifactSourceRepository(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-source-'));
  fs.mkdirSync(path.join(repository, 'packages', 'fast-browser-mcp'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'packages', 'playwright-core'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'packages', 'extension'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'packages', 'fast-browser-mcp', 'README.md'), 'Fast Browser runtime\n');
  fs.writeFileSync(path.join(repository, 'tsconfig.json'), '{}\n');
  fs.writeFileSync(path.join(repository, '.gitignore'), [
    'packages/playwright-core/lib/',
    'packages/extension/dist/',
    '',
  ].join('\n'));
  execFileSync('git', ['init'], { cwd: repository });
  execFileSync('git', ['add', '.'], { cwd: repository });
  execFileSync('git', [
    '-c', 'user.name=Fast Browser Tests',
    '-c', 'user.email=fast-browser-tests@example.invalid',
    'commit', '-m', 'baseline',
  ], { cwd: repository });
  return repository;
}

function createCleanProductionRepository(): string {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-production-source-'));
  const repository = path.join(parentDir, 'repository');
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', rootDir, repository]);

  const relevantPaths = ['LICENSE', 'NOTICE', 'package.json', 'package-lock.json', 'packages', 'utils'];
  const changedFiles = [
    ...execFileSync('git', ['diff', '--name-only', 'HEAD', '--', ...relevantPaths], {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim().split('\n'),
    ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...relevantPaths], {
      cwd: rootDir,
      encoding: 'utf8',
    }).trim().split('\n'),
  ].filter(Boolean);
  for (const file of new Set(changedFiles)) {
    const source = path.join(rootDir, file);
    const destination = path.join(repository, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
  }
  if (changedFiles.length) {
    execFileSync('git', ['add', '-A'], { cwd: repository });
    execFileSync('git', [
      '-c', 'user.name=Fast Browser Tests',
      '-c', 'user.email=fast-browser-tests@example.invalid',
      'commit', '-m', 'apply artifact builder under test',
    ], { cwd: repository });
  }
  fs.symlinkSync(path.join(rootDir, 'node_modules'), path.join(repository, 'node_modules'), 'dir');
  return repository;
}

test('builds self-contained Fast Browser artifacts', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-artifacts-'));
  await buildArtifacts(outDir, '0.1.0-test.1');

  const release = JSON.parse(fs.readFileSync(
      path.join(outDir, 'fast-browser-release-0.1.0-test.1.json'),
      'utf8',
  ));
  expect(release).toMatchObject({
    schemaVersion: 1,
    productVersion: '0.1.0-test.1',
    protocolVersion: 2,
    runtime: { node: '>=20' },
  });
  for (const artifact of [release.runtime, release.extension]) {
    const bytes = fs.readFileSync(path.join(outDir, artifact.file));
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
  }

  execFileSync('tar', ['-xzf', path.join(outDir, release.runtime.file), '-C', outDir]);
  const help = spawnSync(process.execPath, [
    path.join(outDir, 'fast-browser-mcp', 'cli.cjs'),
    '--help',
  ], { encoding: 'utf8' });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('Playwright MCP');

  const configFile = path.join(outDir, 'stdio-config.json');
  fs.writeFileSync(configFile, JSON.stringify({ capabilities: ['core', 'config'] }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(outDir, 'fast-browser-mcp', 'cli.cjs'),
      `--config=${configFile}`,
      `--extension-id=${release.extension.id}`,
      '--snapshot-mode=none',
    ],
    cwd: outDir,
    env: { ...getDefaultEnvironment(), NODE_PATH: '' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'fast-browser-artifact-smoke', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', data => stderr += data.toString());
  try {
    await client.connect(transport);
    expect(client.getServerVersion()?.version).toBe(release.productVersion);
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'browser_get_config',
      'browser_run_code_unsafe',
    ]));
    expect(tools.tools.find(tool => tool.name === 'browser_run_code_unsafe')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    const configResult = await client.callTool({ name: 'browser_get_config', arguments: {} });
    const config = JSON.parse(parseResponse(configResult).result);
    expect(config.extensionId).toBe(release.extension.id);
    expect(config.snapshot.mode).toBe('none');
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\nFast Browser stderr:\n${stderr}`);
  } finally {
    await client.close().catch(() => {});
  }
});

test('extension archive carries all applicable license notices', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-artifacts-'));
  const version = '0.1.0-test.licenses';
  await buildArtifacts(outDir, version);
  const release = JSON.parse(fs.readFileSync(path.join(outDir, `fast-browser-release-${version}.json`), 'utf8'));
  const archive = path.join(outDir, release.extension.file);

  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
  expect(entries).toEqual(expect.arrayContaining([
    'LICENSE',
    'NOTICE',
    'ThirdPartyNotices.txt',
  ]));
  expect(execFileSync('unzip', ['-p', archive, 'LICENSE'], { encoding: 'utf8' })).toContain('Apache License');
  expect(execFileSync('unzip', ['-p', archive, 'NOTICE'], { encoding: 'utf8' })).toContain('Microsoft Corporation');
  const thirdPartyNotices = execFileSync('unzip', ['-p', archive, 'ThirdPartyNotices.txt'], { encoding: 'utf8' });
  expect(thirdPartyNotices).toContain('Copyright (c) Meta Platforms, Inc. and affiliates.');
  expect(thirdPartyNotices).toContain('Copyright (c) 2021 GitHub Inc.');
  expect(thirdPartyNotices).toContain('MIT License');
  for (const packageName of ['react', 'react-dom', 'scheduler']) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'node_modules', packageName, 'package.json'), 'utf8'));
    const displayName = packageName === 'react-dom' ? 'React DOM' : packageName[0].toUpperCase() + packageName.slice(1);
    expect(thirdPartyNotices).toContain(`${displayName} ${packageJson.version}`);
  }
});

test('production builder performs reproducible fresh builds from a clean repository', () => {
  test.setTimeout(120_000);
  const repository = createCleanProductionRepository();
  const version = '0.1.0-test.production';
  const outDirs = [path.join(repository, 'artifacts-a'), path.join(repository, 'artifacts-b')];
  for (const outDir of outDirs) {
    execFileSync(process.execPath, [
      'utils/fast_browser/build_artifacts.mjs',
      '--version', version,
      '--out-dir', outDir,
    ], {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
  }

  const releaseFile = `fast-browser-release-${version}.json`;
  const releases = outDirs.map(outDir => JSON.parse(fs.readFileSync(path.join(outDir, releaseFile), 'utf8')));
  const expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  expect(releases[0].sourceCommit).toBe(expectedCommit);
  expect(releases[1].sourceCommit).toBe(expectedCommit);
  for (const file of [releases[0].runtime.file, releases[0].extension.file, releaseFile])
    expect(fs.readFileSync(path.join(outDirs[0], file))).toEqual(fs.readFileSync(path.join(outDirs[1], file)));
});

for (const failureBoundary of [
  'backup:runtime',
  'backup:extension',
  'backup:manifest',
  'promote:runtime',
  'promote:extension',
  'promote:manifest',
] as const) {
  test(`rolls back the same-version release after ${failureBoundary}`, async () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-artifacts-'));
    const outDir = path.join(parentDir, 'release');
    fs.mkdirSync(outDir);
    const version = '0.1.0-test.transaction';
    const previousFiles = new Map([
      [`fast-browser-mcp-${version}.tar.gz`, Buffer.from('previous runtime')],
      [`fast-browser-extension-${version}.zip`, Buffer.from('previous extension')],
      [`fast-browser-release-${version}.json`, Buffer.from('previous manifest')],
    ]);
    for (const [file, bytes] of previousFiles)
      fs.writeFileSync(path.join(outDir, file), bytes);

    await expect(buildArtifactsForTesting(outDir, version, {
      onTransactionBoundary: boundary => {
        if (boundary === failureBoundary)
          throw new Error(`injected ${failureBoundary} failure`);
      },
    })).rejects.toThrow(`injected ${failureBoundary} failure`);
    for (const [file, bytes] of previousFiles)
      expect(fs.readFileSync(path.join(outDir, file))).toEqual(bytes);
    expect(fs.readdirSync(outDir).sort()).toEqual([...previousFiles.keys()].sort());
  });
}

test('preserves recovery files when release rollback fails', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-artifacts-'));
  const version = '0.1.0-test.rollback-recovery';
  const runtimeFile = `fast-browser-mcp-${version}.tar.gz`;
  const extensionFile = `fast-browser-extension-${version}.zip`;
  const releaseFile = `fast-browser-release-${version}.json`;
  for (const file of [runtimeFile, extensionFile, releaseFile])
    fs.writeFileSync(path.join(outDir, file), `previous ${file}`);

  const renameSync: typeof fs.renameSync = (source, destination) => {
    if (source.toString().includes(`${path.sep}previous-release${path.sep}`) &&
        path.basename(destination.toString()) === runtimeFile)
      throw new Error('injected rollback restore failure');
    fs.renameSync(source, destination);
  };
  let caught: any;
  try {
    await buildArtifactsForTesting(outDir, version, {
      renameSync,
      onTransactionBoundary: boundary => {
        if (boundary === 'promote:extension')
          throw new Error('injected promotion failure');
      },
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(AggregateError);
  expect(caught.message).toContain('rollback failed');
  expect(caught.message).toContain('Recovery files preserved at');
  expect(path.dirname(caught.recoveryDirectory)).toBe(fs.realpathSync(outDir));
  expect(fs.existsSync(path.join(caught.recoveryDirectory, 'previous-release', `0-${runtimeFile}`))).toBe(true);
});

test('resolves a symlinked output directory to its physical location', async () => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-artifacts-'));
  const physicalOutDir = path.join(parentDir, 'physical-output');
  const linkedOutDir = path.join(parentDir, 'linked-output');
  fs.mkdirSync(physicalOutDir);
  fs.symlinkSync(physicalOutDir, linkedOutDir, 'dir');

  const builder = await import(pathToFileURL(path.join(rootDir, 'utils/fast_browser/build_artifacts.mjs')).href);
  expect(builder.resolveOutputDirectory(linkedOutDir)).toBe(fs.realpathSync(physicalOutDir));
});

test('stages artifacts inside the resolved physical output directory', async () => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-artifacts-'));
  const physicalOutDir = path.join(parentDir, 'physical-output');
  const linkedOutDir = path.join(parentDir, 'linked-output');
  fs.mkdirSync(physicalOutDir);
  fs.symlinkSync(physicalOutDir, linkedOutDir, 'dir');
  const builder = await loadArtifactBuilder();

  const stagingDir = builder.createArtifactStagingDirectory(linkedOutDir);
  expect(path.dirname(stagingDir)).toBe(fs.realpathSync(physicalOutDir));
});

test('rejects dirty relevant source before preparing artifact inputs', async () => {
  const repository = createCommittedArtifactSourceRepository();
  fs.appendFileSync(path.join(repository, 'packages', 'fast-browser-mcp', 'README.md'), 'dirty\n');
  const builder = await loadArtifactBuilder();
  let buildCalled = false;

  expect(() => builder.prepareRepositoryForArtifactBuild(repository, {
    runBuild: () => buildCalled = true,
  })).toThrow(/dirty relevant source.*packages\/fast-browser-mcp\/README\.md/s);
  expect(buildCalled).toBe(false);
});

test('rejects a dirty root build configuration before preparing artifact inputs', async () => {
  const repository = createCommittedArtifactSourceRepository();
  fs.writeFileSync(path.join(repository, 'tsconfig.json'), '{ "compilerOptions": { "target": "ES5" } }\n');
  const builder = await loadArtifactBuilder();
  let buildCalled = false;

  expect(() => builder.prepareRepositoryForArtifactBuild(repository, {
    runBuild: () => buildCalled = true,
  })).toThrow(/dirty relevant source.*tsconfig\.json/s);
  expect(buildCalled).toBe(false);
});

test('removes stale package output before the controlled artifact build', async () => {
  const repository = createCommittedArtifactSourceRepository();
  const coreOutput = path.join(repository, 'packages', 'playwright-core', 'lib');
  const extensionOutput = path.join(repository, 'packages', 'extension', 'dist');
  fs.mkdirSync(coreOutput, { recursive: true });
  fs.mkdirSync(extensionOutput, { recursive: true });
  fs.writeFileSync(path.join(coreOutput, 'stale.js'), 'stale core');
  fs.writeFileSync(path.join(extensionOutput, 'stale.js'), 'stale extension');
  const builder = await loadArtifactBuilder();
  let buildCalls = 0;

  const commit = builder.prepareRepositoryForArtifactBuild(repository, {
    runBuild: buildRoot => {
      ++buildCalls;
      expect(buildRoot).toBe(repository);
      expect(fs.existsSync(coreOutput)).toBe(false);
      expect(fs.existsSync(extensionOutput)).toBe(false);
      fs.mkdirSync(coreOutput, { recursive: true });
      fs.mkdirSync(extensionOutput, { recursive: true });
      fs.writeFileSync(path.join(coreOutput, 'fresh.js'), 'fresh core');
      fs.writeFileSync(path.join(extensionOutput, 'fresh.js'), 'fresh extension');
    },
  });

  expect(buildCalls).toBe(1);
  expect(commit).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim());
  expect(fs.readdirSync(coreOutput)).toEqual(['fresh.js']);
  expect(fs.readdirSync(extensionOutput)).toEqual(['fresh.js']);
});

test('rejects relevant source changes made after the controlled build', async () => {
  const repository = createCommittedArtifactSourceRepository();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  fs.appendFileSync(path.join(repository, 'packages', 'fast-browser-mcp', 'README.md'), 'changed during packaging\n');
  const builder = await loadArtifactBuilder();

  expect(() => builder.verifyRepositoryProvenance(repository, commit)).toThrow(
      /dirty relevant source.*packages\/fast-browser-mcp\/README\.md/s);
});

test('revalidates source provenance after archives and before publication', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-artifacts-'));
  let verificationCalled = false;

  await expect(buildArtifactsForTesting(outDir, '0.1.0-test.final-provenance', {
    verifyProvenance: () => {
      verificationCalled = true;
      throw new Error('injected final provenance failure');
    },
  })).rejects.toThrow('injected final provenance failure');
  expect(verificationCalled).toBe(true);
  expect(fs.readdirSync(outDir)).toEqual([]);
});

test('Fast Browser CI runs the focused Chrome contract on Node 20 and 22', () => {
  const workflow = parse(fs.readFileSync('.github/workflows/tests_fast_browser.yml', 'utf8'));
  const job = workflow.jobs.test;
  expect(job['runs-on']).toBe('macos-latest');
  expect(job.strategy.matrix['node-version']).toEqual(['20', '22']);
  const setupNode = job.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
  expect(setupNode.with['node-version']).toBe('${{ matrix.node-version }}');
  const mcpCommand = job.steps.find(step => step.run?.includes('fast-browser-contract.spec.ts')).run.split(/\s+/);
  expect(mcpCommand).toEqual([
    'npm', 'run', 'test-mcp', '--', '--project=chrome',
    'fast-browser-contract.spec.ts',
    'fast-browser-artifacts.spec.ts',
    'run-code.spec.ts',
    'snapshot-mode.spec.ts',
    'timeouts.spec.ts',
  ]);
  const upload = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  expect(upload.if).toBe("matrix.node-version == '22'");
});

test('Fast Browser CI path gate covers protected implementation and package manifests', () => {
  const workflow = parse(fs.readFileSync('.github/workflows/tests_fast_browser.yml', 'utf8'));
  expect(workflow.on.pull_request.paths).toEqual(expect.arrayContaining([
    'LICENSE',
    'NOTICE',
    'packages/playwright-core/src/tools/**',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tests/mcp/run-code.spec.ts',
    'tests/mcp/snapshot-mode.spec.ts',
    'tests/mcp/timeouts.spec.ts',
    'utils/build/**',
  ]));
});

test('Fast Browser publish workflow builds and uploads the checked-in release set', () => {
  const workflow = parse(fs.readFileSync('.github/workflows/publish_fast_browser.yml', 'utf8'));
  const commands = workflow.jobs.publish.steps.filter(step => step.run).map(step => step.run);
  expect(commands).toEqual(expect.arrayContaining([
    'node utils/fast_browser/build_artifacts.mjs --version "${{ steps.version.outputs.value }}" --out-dir fast-browser-dist',
    'gh release upload "$GITHUB_REF_NAME" fast-browser-dist/* --clobber',
  ]));
});
