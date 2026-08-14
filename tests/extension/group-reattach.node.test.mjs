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

// FB-58. An anti-bot page that reloads itself to the SAME url after its
// challenge detaches the debugger, and the reload never changes the tab's
// url -- so tabs.onUpdated fires with only a `status` change. The group's
// re-attach path used to key exclusively off `changeInfo.url`, which made a
// same-url reload unrecoverable: the one-shot _reattachSurvivors probe races
// the reload window, and nothing ever retried.
//
// Drives ConnectedTabGroup + RelayConnection against a fake chrome, same
// posture as relay-policy.node.test.mjs.
//
// Run with:  node --test tests/extension/group-reattach.node.test.mjs

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import esbuild from 'esbuild';

const repoRoot = path.resolve(import.meta.dirname, '../..');

async function loadClasses() {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'group-reattach-'));
  const entry = path.join(outDir, 'entry.ts');
  await fs.writeFile(entry, [
    `export { ConnectedTabGroup } from ${JSON.stringify(path.join(repoRoot, 'packages/extension/src/connectedTabGroup'))};`,
    `export { RelayConnection } from ${JSON.stringify(path.join(repoRoot, 'packages/extension/src/relayConnection'))};`,
  ].join('\n'));
  const outfile = path.join(outDir, 'bundle.mjs');
  await esbuild.build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'neutral' });
  return await import(pathToFileURL(outfile).href);
}

function makeEvent() {
  const listeners = [];
  return {
    addListener: l => listeners.push(l),
    removeListener: l => {
      const i = listeners.indexOf(l);
      if (i >= 0)
        listeners.splice(i, 1);
    },
    fire: (...args) => listeners.slice().forEach(l => l(...args)),
  };
}

function installChromeMock(groupTabs) {
  const mock = {
    runtime: { getURL: p => `chrome-extension://test/${p}` },
    debugger: {
      onEvent: makeEvent(),
      onDetach: makeEvent(),
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => ({}),
    },
    tabs: {
      onCreated: makeEvent(),
      onRemoved: makeEvent(),
      onUpdated: makeEvent(),
      create: async () => ({ id: 99 }),
      remove: async () => {},
      get: async tabId => groupTabs.find(t => t.id === tabId),
      query: async () => groupTabs,
      group: async () => 1,
      ungroup: async () => {},
    },
    tabGroups: {
      update: async () => {},
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
    action: {
      setBadgeText: async () => {},
      setTitle: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
  };
  globalThis.chrome = mock;
  globalThis.WebSocket = { OPEN: 1 };
  return mock;
}

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
}

const settle = async () => {
  for (let i = 0; i < 4; i++)
    await new Promise(resolve => setImmediate(resolve));
};

// The relay marks a tab attached by sending chrome.debugger.attach back over
// the socket; this plays that role.
async function completeAttach(socket, tabId, id = 1) {
  socket.onmessage({ data: JSON.stringify({ id, method: 'chrome.debugger.attach', params: [{ tabId }] }) });
  await settle();
}

function attachRequestsFor(socket, tabId) {
  return socket.sent.filter(m => m.method === 'chrome.tabs.onCreated' && m.params?.[0]?.id === tabId);
}

test('a same-url reload (status-only onUpdated) triggers a re-attach of a group tab', async () => {
  const { ConnectedTabGroup, RelayConnection } = await loadClasses();
  const tab = { id: 42, url: 'https://shop.example/checkout', groupId: 1 };
  const mock = installChromeMock([tab]);
  const socket = new FakeSocket();
  const connection = new RelayConnection(socket);
  new ConnectedTabGroup(connection, tab, { title: 'FB', color: 'blue' }, 999);
  await completeAttach(socket, 42);

  // The challenge reload: Chrome yanks the debugger, the tab stays put.
  mock.debugger.onDetach.fire({ tabId: 42 }, 'target_closed');
  await settle();
  // _reattachSurvivors' immediate probe went out; mid-reload it goes
  // unanswered, which is the failure mode being fixed. Drop it.
  socket.sent.length = 0;

  // The reload finishes. Same url, so onUpdated carries only a status change.
  mock.tabs.onUpdated.fire(42, { status: 'complete' }, tab);
  await settle();

  assert.ok(
      attachRequestsFor(socket, 42).length > 0,
      'a status-only update of a group tab must retry the attach');
  connection.close('cleanup');
});

test('a status-only onUpdated for an already-attached tab does not re-request attach', async () => {
  const { ConnectedTabGroup, RelayConnection } = await loadClasses();
  const tab = { id: 42, url: 'https://shop.example/checkout', groupId: 1 };
  const mock = installChromeMock([tab]);
  const socket = new FakeSocket();
  const connection = new RelayConnection(socket);
  new ConnectedTabGroup(connection, tab, { title: 'FB', color: 'blue' }, 999);
  await completeAttach(socket, 42);
  socket.sent.length = 0;

  mock.tabs.onUpdated.fire(42, { status: 'complete' }, tab);
  await settle();

  assert.equal(
      attachRequestsFor(socket, 42).length, 0,
      'an attached tab must not be re-requested on load progress');
  connection.close('cleanup');
});

test('a status-only onUpdated for a non-debuggable url does not attach', async () => {
  const { ConnectedTabGroup, RelayConnection } = await loadClasses();
  const tab = { id: 42, url: 'https://shop.example/checkout', groupId: 1 };
  const mock = installChromeMock([tab]);
  const socket = new FakeSocket();
  const connection = new RelayConnection(socket);
  new ConnectedTabGroup(connection, tab, { title: 'FB', color: 'blue' }, 999);
  await completeAttach(socket, 42);

  mock.debugger.onDetach.fire({ tabId: 42 }, 'target_closed');
  await settle();
  socket.sent.length = 0;

  const chromeTab = { id: 42, url: 'chrome://settings', groupId: 1 };
  mock.tabs.onUpdated.fire(42, { status: 'complete' }, chromeTab);
  await settle();

  assert.equal(
      attachRequestsFor(socket, 42).length, 0,
      'a chrome:// tab must not be attached on load progress');
  connection.close('cleanup');
});
