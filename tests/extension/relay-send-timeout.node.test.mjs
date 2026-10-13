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

// Every relay send carries a timeout: a command the extension never answers
// fails with a relay timeout instead of hanging the session.
//
// Run with:  node --test tests/extension/relay-send-timeout.node.test.mjs

import assert from 'node:assert';
import http from 'node:http';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import esbuild from 'esbuild';
import { WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../..');
async function loadCdpRelayServer() {
  // Under the repo, not os.tmpdir(): the bundle leaves bare imports (debug,
  // ws) external, and node resolves them by walking up from the bundle's own
  // path, which must land in this repo's node_modules.
  const cacheRoot = path.join(repoRoot, 'node_modules', '.cache');
  await fs.mkdir(cacheRoot, { recursive: true });
  const outDir = await fs.mkdtemp(path.join(cacheRoot, 'relay-send-timeout-'));
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

process.env.PLAYWRIGHT_MCP_RELAY_SEND_TIMEOUT = '300';
process.env.PLAYWRIGHT_MCP_RELAY_PAGE_PACED_TIMEOUT = '1200';

const CDPRelayServer = await loadCdpRelayServer();

function listeningServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}


function open(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

// A fake extension that completes the tab attach handshake and then replies
// only to the CDP methods named in `answers`; every other command stalls.
async function stalledRelay(answers = {}) {
  const server = await listeningServer();
  const relay = new CDPRelayServer(server, 'chrome', undefined, 'test-extension-id');
  const extension = await open(relay.extensionEndpoint());
  const stalled = [];
  extension.on('message', raw => {
    const { id, method, params } = JSON.parse(raw.toString());
    if (method === 'chrome.debugger.attach')
      return extension.send(JSON.stringify({ id, result: {} }));
    const cdpMethod = method === 'chrome.debugger.sendCommand' ? params[1] : method;
    if (cdpMethod === 'Target.getTargetInfo')
      return extension.send(JSON.stringify({ id, result: { targetInfo: { targetId: 'T1', type: 'page', url: 'about:blank', title: '' } } }));
    if (cdpMethod in answers)
      return extension.send(JSON.stringify({ id, result: answers[cdpMethod] }));
    stalled.push({ id, cdpMethod });
  });
  extension.send(JSON.stringify({ method: 'chrome.tabs.onCreated', params: [{ id: 7, index: 0, windowId: 1, active: true, pinned: false }] }));
  extension.send(JSON.stringify({ method: 'extension.initialized', params: [] }));

  const cdp = await open(relay.cdpEndpoint());
  const inbox = [];
  cdp.on('message', raw => inbox.push(JSON.parse(raw.toString())));
  const next = async (match, withinMs) => {
    const deadline = Date.now() + withinMs;
    for (;;) {
      const hit = inbox.find(match);
      if (hit)
        return hit;
      if (Date.now() > deadline)
        throw new Error('the relay never answered: the send hung');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  let lastId = 0;
  const send = (method, sessionId, params) => {
    const id = ++lastId;
    cdp.send(JSON.stringify({ id, method, sessionId, params }));
    return id;
  };
  send('Target.setAutoAttach', undefined, { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const attached = await next(m => m.method === 'Target.attachedToTarget', 5000);
  return {
    extension, stalled, send, next, sessionId: attached.params.sessionId,
    close: () => { cdp.close(); extension.close(); relay.stop(); server.close(); },
  };
}

test('a command the extension never answers fails with a relay timeout, not a hang', async () => {
  const relay = await stalledRelay();
  try {
    const started = Date.now();
    const id = relay.send('Page.captureScreenshot', relay.sessionId, { format: 'png' });
    const reply = await relay.next(m => m.id === id, 3000);
    assert.match(reply.error.message, /Relay timeout: Page\.captureScreenshot got no reply from the extension within 300ms/);
    assert.ok(Date.now() - started >= 250, 'the timeout is not immediate');
  } finally { relay.close(); }
});

test('a browser-level attach, the command the spike saw hang, fails the same way', async () => {
  const relay = await stalledRelay();
  try {
    const id = relay.send('Target.attachToBrowserTarget');
    const reply = await relay.next(m => m.id === id, 3000);
    assert.match(reply.error.message, /Relay timeout: Target\.attachToBrowserTarget/);
  } finally { relay.close(); }
});

test('a page-paced command gets the longer ceiling and still fails in the end', async () => {
  const relay = await stalledRelay();
  try {
    const started = Date.now();
    const id = relay.send('Runtime.evaluate', relay.sessionId, { expression: 'new Promise(() => {})', awaitPromise: true });
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(await relay.next(m => m.id === id, 1).catch(() => 'pending'), 'pending', 'it outlives the 300ms command timeout');
    const reply = await relay.next(m => m.id === id, 3000);
    assert.match(reply.error.message, /Relay timeout: Runtime\.evaluate got no reply from the extension within 1200ms/);
    assert.ok(Date.now() - started >= 1100);
  } finally { relay.close(); }
});

for (const method of ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText']) {
  test(`${method} returns when the page's handlers do, so it gets the longer ceiling`, async () => {
    const relay = await stalledRelay();
    try {
      const id = relay.send(method, relay.sessionId, { type: 'mousePressed', x: 1, y: 1, text: 'a' });
      await new Promise(resolve => setTimeout(resolve, 700));
      assert.equal(await relay.next(m => m.id === id, 1).catch(() => 'pending'), 'pending', 'it outlives the 300ms command timeout');
      const reply = await relay.next(m => m.id === id, 3000);
      assert.match(reply.error.message, new RegExp(`Relay timeout: ${method.replace('.', '\\.')} got no reply from the extension within 1200ms`));
    } finally { relay.close(); }
  });
}

test('a timed-out send does not poison the connection, and its late reply is ignored', async () => {
  const relay = await stalledRelay({ 'Page.getLayoutMetrics': { cssVisualViewport: { clientWidth: 10, clientHeight: 10 } } });
  try {
    const stuck = relay.send('Page.captureScreenshot', relay.sessionId, { format: 'png' });
    await relay.next(m => m.id === stuck, 3000);
    relay.extension.send(JSON.stringify({ id: relay.stalled[0].id, result: { data: 'late' } }));
    const id = relay.send('Page.getLayoutMetrics', relay.sessionId);
    const reply = await relay.next(m => m.id === id, 3000);
    assert.equal(reply.result.cssVisualViewport.clientWidth, 10);
  } finally { relay.close(); }
});
