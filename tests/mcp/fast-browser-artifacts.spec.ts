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

test('builds self-contained Fast Browser artifacts', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-artifacts-'));
  execFileSync(process.execPath, [
    'utils/fast_browser/build_artifacts.mjs',
    '--version', '0.1.0-test.1',
    '--out-dir', outDir,
  ], { cwd: path.resolve(__dirname, '../..'), stdio: 'inherit' });

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
  const rootDir = path.resolve(__dirname, '../..');
  const outDirs = [
    fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-artifacts-a-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'fast-browser-artifacts-b-')),
  ];
  for (const outDir of outDirs) {
    execFileSync(process.execPath, [
      'utils/fast_browser/build_artifacts.mjs',
      '--version', '0.1.0-test.2',
      '--out-dir', outDir,
    ], { cwd: rootDir, stdio: 'inherit' });
  }

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
