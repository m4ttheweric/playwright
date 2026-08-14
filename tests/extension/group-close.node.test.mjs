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

// FB-59. Chrome's "started debugging this browser" infobar sticks to each
// debugged tab and outlives the detach; only dismissing it or closing the
// tab removes it. Ended sessions used to leave every controlled tab open
// (ungrouped), so each session parked one dead banner per tab on the user's
// browser, accumulating into the hundreds.
//
// The distinction that keeps this safe: tabs the SESSION created (relay
// chrome.tabs.create, popups opened by a controlled page) are session
// scaffolding and close with a cleanly-ended session, like the connect page
// already does. Tabs the user brought in are the user's and are only ever
// ungrouped. An unclean drop (socket death) preserves everything.
//
// Run with:  node --test tests/extension/group-close.node.test.mjs

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import esbuild from 'esbuild';

const repoRoot = path.resolve(import.meta.dirname, '../..');

async function loadClasses() {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'group-close-'));
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

function installChromeMock() {
  const removed = [];
  const ungrouped = [];
  let nextTabId = 70;
  const mock = {
    removed,
    ungrouped,
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
      create: async () => ({ id: ++nextTabId }),
      remove: async tabIds => { removed.push(...[tabIds].flat()); },
      get: async () => { throw new Error('no such tab'); },
      query: async () => [],
      group: async () => 1,
      ungroup: async tabIds => { ungrouped.push(...[tabIds].flat()); },
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

async function command(socket, method, params, id = 1) {
  socket.onmessage({ data: JSON.stringify({ id, method, params }) });
  await settle();
}

// Builds a session around user-selected tab 42, with the relay then creating
// tab 71 (chrome.tabs.create through the command channel) and attaching both.
async function sessionWithCreatedTab() {
  const { ConnectedTabGroup, RelayConnection } = await loadClasses();
  const selected = { id: 42, url: 'https://shop.example/checkout' };
  const mock = installChromeMock();
  const socket = new FakeSocket();
  const connection = new RelayConnection(socket);
  new ConnectedTabGroup(connection, selected, { title: 'FB', color: 'blue' }, 999);
  await command(socket, 'chrome.debugger.attach', [{ tabId: 42 }], 1);
  await command(socket, 'chrome.tabs.create', [{}], 2);
  await command(socket, 'chrome.debugger.attach', [{ tabId: 71 }], 3);
  return { mock, socket, connection };
}

test('a clean close removes the tabs the session created and only ungroups the selected tab', async () => {
  const { mock, connection } = await sessionWithCreatedTab();

  connection.close('client done');
  await settle();

  assert.deepEqual(mock.removed, [71], 'the relay-created tab must close with the session');
  assert.deepEqual(mock.ungrouped, [42], 'the user-selected tab must be preserved, only ungrouped');
});

test('an unclean drop preserves every tab, created ones included', async () => {
  const { mock, socket } = await sessionWithCreatedTab();

  socket.onclose({ code: 1006 });
  await settle();

  assert.deepEqual(mock.removed, [], 'a dropped socket must not destroy any page');
  assert.deepEqual(mock.ungrouped.sort(), [42, 71], 'every tab is preserved and ungrouped');
});

test('a popup opened by a controlled page counts as session-created', async () => {
  const { ConnectedTabGroup, RelayConnection } = await loadClasses();
  const selected = { id: 42, url: 'https://shop.example/checkout' };
  const mock = installChromeMock();
  const socket = new FakeSocket();
  const connection = new RelayConnection(socket);
  new ConnectedTabGroup(connection, selected, { title: 'FB', color: 'blue' }, 999);
  await command(socket, 'chrome.debugger.attach', [{ tabId: 42 }], 1);

  // The controlled page window.open()s a popup; Chrome reports it with the
  // opener set. The relay then attaches it.
  mock.tabs.onCreated.fire({ id: 88, openerTabId: 42, url: 'https://shop.example/receipt' });
  await settle();
  await command(socket, 'chrome.debugger.attach', [{ tabId: 88 }], 2);

  connection.close('client done');
  await settle();

  assert.deepEqual(mock.removed, [88], 'the popup closes with the session');
  assert.deepEqual(mock.ungrouped, [42], 'the user-selected tab is only ungrouped');
});
