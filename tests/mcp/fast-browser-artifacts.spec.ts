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
import { test, expect } from './fixtures';

const rootDir = path.resolve(__dirname, '../..');

function buildArtifacts(outDir: string, version: string, env?: NodeJS.ProcessEnv) {
  execFileSync(process.execPath, [
    'utils/fast_browser/build_artifacts.mjs',
    '--version', version,
    '--out-dir', outDir,
  ], { cwd: rootDir, env, stdio: 'inherit' });
}

test('builds self-contained Fast Browser artifacts', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-artifacts-'));
  buildArtifacts(outDir, '0.1.0-test.1');

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
});

test('builds reproducible Fast Browser artifact bytes', () => {
  const outDirs = [
    fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-artifacts-a-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-artifacts-b-')),
  ];
  for (const outDir of outDirs)
    buildArtifacts(outDir, '0.1.0-test.2');

  const artifacts = outDirs.map(outDir => JSON.parse(fs.readFileSync(
    path.join(outDir, 'fast-browser-release-0.1.0-test.2.json'),
    'utf8',
  )));
  for (const artifact of ['runtime', 'extension'] as const) {
    const first = fs.readFileSync(path.join(outDirs[0], artifacts[0][artifact].file));
    const second = fs.readFileSync(path.join(outDirs[1], artifacts[1][artifact].file));
    expect(first).toEqual(second);
    expect(artifacts[0][artifact].sha256).toBe(artifacts[1][artifact].sha256);
  }
});

test('keeps the previous release set when artifact creation fails', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-artifacts-'));
  const version = '0.1.0-test.3';
  buildArtifacts(outDir, version);

  const releaseFile = `fast-browser-release-${version}.json`;
  const release = JSON.parse(fs.readFileSync(path.join(outDir, releaseFile), 'utf8'));
  const previousFiles = [release.runtime.file, release.extension.file, releaseFile];
  const previousBytes = new Map(previousFiles.map(file => [file, fs.readFileSync(path.join(outDir, file))]));
  const launcherReadme = path.join(rootDir, 'packages', 'fast-browser-mcp', 'README.md');
  const originalReadme = fs.readFileSync(launcherReadme);
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-zip-shim-'));
  const zipShim = path.join(shimDir, 'zip');
  fs.writeFileSync(zipShim, '#!/bin/sh\nexit 7\n', { mode: 0o755 });

  try {
    fs.appendFileSync(launcherReadme, '\nTemporary artifact test change.\n');
    expect(() => buildArtifacts(outDir, version, {
      ...process.env,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
    })).toThrow();
    for (const [file, bytes] of previousBytes)
      expect(fs.readFileSync(path.join(outDir, file))).toEqual(bytes);
  } finally {
    fs.writeFileSync(launcherReadme, originalReadme);
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});

test('stages artifacts beside the output directory', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-artifacts-'));
  const unavailableTmpDir = path.join(outDir, 'does-not-exist');
  buildArtifacts(outDir, '0.1.0-test.4', {
    ...process.env,
    TMPDIR: unavailableTmpDir,
  });
  expect(fs.existsSync(path.join(outDir, 'fast-browser-release-0.1.0-test.4.json'))).toBe(true);
});

test('release workflows call the checked-in artifact builder', () => {
  const testWorkflow = fs.readFileSync('.github/workflows/tests_fast_browser.yml', 'utf8');
  const publishWorkflow = fs.readFileSync('.github/workflows/publish_fast_browser.yml', 'utf8');
  expect(testWorkflow).toContain('npm run test-mcp -- fast-browser-');
  expect(testWorkflow).toContain('npm run test-extension -- extension.spec.ts multi-connection.spec.ts tab-grouping.spec.ts');
  expect(publishWorkflow).toContain('node utils/fast_browser/build_artifacts.mjs');
  expect(publishWorkflow).toContain('gh release upload');
});
