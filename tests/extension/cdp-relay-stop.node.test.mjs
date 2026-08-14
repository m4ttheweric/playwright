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

// FB-58. Every relay-crash cycle used to leak one listening port: stop()
// closed the WebSocket layer but never the HTTP server under it, and after a
// successful connect nothing called stop() at all. The relay owns its server
// for its whole life, so stopping the relay must free the port.
//
// Bundles the real source with esbuild (same posture as
// relay-policy.node.test.mjs), resolving the repo's @isomorphic/@utils path
// aliases and leaving node_modules imports external.
//
// Run with:  node --test tests/extension/cdp-relay-stop.node.test.mjs

import assert from 'node:assert';
import http from 'node:http';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');

async function loadCdpRelayServer() {
  // Under the repo, not os.tmpdir(): the bundle leaves bare imports (debug,
  // ws) external, and node resolves them by walking up from the bundle's own
  // path, which must land in this repo's node_modules.
  const cacheRoot = path.join(repoRoot, 'node_modules', '.cache');
  await fs.mkdir(cacheRoot, { recursive: true });
  const outDir = await fs.mkdtemp(path.join(cacheRoot, 'cdp-relay-stop-'));
  const outfile = path.join(outDir, 'cdpRelay.cjs');
  // The relay pulls in the browser registry only to resolve executables when
  // it launches Chrome, which these tests never do. The real module drags in
  // half of playwright-core (and a __dirname-relative package.json read that
  // breaks outside the built tree), so stub it.
  const registryStub = path.join(outDir, 'registry-stub.js');
  await fs.writeFile(registryStub, [
    'module.exports = { registry: {',
    '  isChromiumAlias: () => false,',
    '  findExecutable: () => undefined,',
    '} };',
  ].join('\n'));
  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'packages/playwright-core/src/tools/mcp/cdpRelay.ts')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    packages: 'external',
    alias: {
      '@isomorphic': path.join(repoRoot, 'packages/isomorphic'),
      '@utils': path.join(repoRoot, 'packages/utils'),
    },
    plugins: [{
      name: 'stub-registry',
      setup(build) {
        build.onResolve({ filter: /server\/registry/ }, () => ({ path: registryStub }));
      },
    }],
  });
  return require(outfile).CDPRelayServer;
}

const CDPRelayServer = await loadCdpRelayServer();

function listeningServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('stop() closes the HTTP server the relay owns, freeing its port', async () => {
  const server = await listeningServer();
  try {
    const relay = new CDPRelayServer(server, 'chrome', undefined, 'test-extension-id');
    assert.equal(server.listening, true, 'precondition: the relay port is listening');

    relay.stop();

    assert.equal(server.listening, false, 'a stopped relay must not keep its port');
  } finally {
    // Pre-fix, the leaked listener also keeps this PROCESS alive forever --
    // the test-level symptom of the bug. Always release it so the failure
    // surfaces as the assertion, not a hang.
    server.close();
  }
});

test('stop() is idempotent', async () => {
  const server = await listeningServer();
  try {
    const relay = new CDPRelayServer(server, 'chrome', undefined, 'test-extension-id');
    relay.stop();
    relay.stop();
    assert.equal(server.listening, false);
  } finally {
    server.close();
  }
});
