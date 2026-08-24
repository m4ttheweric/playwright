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

// MAT-124. The browser-level repro for this is unusable: the only trigger that
// produces the harmful shape (a Memory Saver discard of the attached tab) takes
// the whole Chrome process down, so it can never distinguish "the relay closed
// the session" from "the browser died". This exercises the policy directly
// instead, against a fake chrome and a fake socket.
//
// Run with:  node --test tests/extension/relay-policy.node.test.mjs
// Pass PRE_FIX=1 to bundle the pre-fix source from git instead, which is how
// these assertions were confirmed to actually catch the bug.

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import esbuild from 'esbuild';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const sourcePath = 'packages/extension/src/relayConnection.ts';
const kGraceMs = 1000;

async function loadRelayConnection() {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-policy-'));
  let entry = path.join(repoRoot, sourcePath);
  if (process.env.PRE_FIX) {
    const previous = execFileSync('git', ['show', `HEAD:${sourcePath}`], { cwd: repoRoot, encoding: 'utf8' });
    entry = path.join(outDir, 'relayConnection.ts');
    await fs.writeFile(entry, previous);
  }
  const outfile = path.join(outDir, 'relayConnection.mjs');
  await esbuild.build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'neutral' });
  return (await import(pathToFileURL(outfile).href)).RelayConnection;
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
      create: async () => ({ id: 99 }),
      remove: async () => {},
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

// The relay drives attachment by sending chrome.debugger.attach over the
// socket, which is what marks the tab attached inside RelayConnection.
async function attachTab(socket, tabId, id = 1) {
  socket.onmessage({ data: JSON.stringify({ id, method: 'chrome.debugger.attach', params: [{ tabId }] }) });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('an involuntary detach of the last tab does not close the session immediately', async () => {
  const RelayConnection = await loadRelayConnection();
  const mock = installChromeMock();
  const socket = new FakeSocket();
  const connection = new RelayConnection(socket);

  await attachTab(socket, 42);
  mock.debugger.onDetach.fire({ tabId: 42 }, 'target_closed');

  assert.equal(socket.closed, null, 'chrome detaching the debugger must not tear the relay down on the spot');
  connection.close('cleanup');
});

test('an involuntary detach still closes the session when the tab is genuinely removed', async () => {
  const RelayConnection = await loadRelayConnection();
  const mock = installChromeMock();
  const socket = new FakeSocket();
  new RelayConnection(socket);

  await attachTab(socket, 42);
  mock.debugger.onDetach.fire({ tabId: 42 }, 'target_closed');
  mock.tabs.onRemoved.fire(42);
  await wait(kGraceMs + 500);

  assert.ok(socket.closed, 'a session whose last tab is gone for real should still end');
});

// FB-58: an anti-bot page (Anubis-style proof-of-work) reloads itself after
// the challenge. The reload detaches the debugger, but the tab is still right
// there in the strip, loading the real page. A 1-second deadline loses that
// race; only genuine removal or a much longer watch expiry may end the
// session while the tab exists.
test('an involuntary detach of a tab that still exists outlives the old 1s grace', async () => {
  const RelayConnection = await loadRelayConnection();
  const mock = installChromeMock();
  const socket = new FakeSocket();
  const connection = new RelayConnection(socket);

  await attachTab(socket, 42);
  mock.debugger.onDetach.fire({ tabId: 42 }, 'target_closed');
  await wait(kGraceMs + 500);

  assert.equal(socket.closed, null, 'a detached-but-present tab must get more than 1s to come back');
  connection.close('cleanup');
});

test('the watch expires when the detached tab never comes back', async () => {
  const RelayConnection = await loadRelayConnection();
  const mock = installChromeMock();
  const socket = new FakeSocket();
  new RelayConnection(socket, { detachedTabWatchMs: 2000 });

  await attachTab(socket, 42);
  mock.debugger.onDetach.fire({ tabId: 42 }, 'target_closed');
  await wait(1500);
  assert.equal(socket.closed, null, 'the watch must still be open at 1.5s');
  await wait(1000);
  assert.ok(socket.closed, 'an expired watch with nothing attached should end the session');
});

test('a reattach late in the watch, past the old grace, cancels the close', async () => {
  const RelayConnection = await loadRelayConnection();
  const mock = installChromeMock();
  const socket = new FakeSocket();
  const connection = new RelayConnection(socket, { detachedTabWatchMs: 2000 });

  await attachTab(socket, 42);
  mock.debugger.onDetach.fire({ tabId: 42 }, 'target_closed');
  await wait(kGraceMs + 200);
  await attachTab(socket, 42, 2);
  await wait(1500);

  assert.equal(socket.closed, null, 'a tab that came back during the watch must keep the session alive');
  connection.close('cleanup');
});

test('reattaching a successor within the grace keeps the session alive', async () => {
  const RelayConnection = await loadRelayConnection();
  const mock = installChromeMock();
  const socket = new FakeSocket();
  new RelayConnection(socket);

  await attachTab(socket, 42);
  mock.debugger.onDetach.fire({ tabId: 42 }, 'target_closed');

  // What ConnectedTabGroup._reattachSurvivors does: attach the successor tab,
  // which carries a new id after a discard.
  await attachTab(socket, 43, 2);
  await wait(kGraceMs + 500);

  assert.equal(socket.closed, null, 'a reattached successor should cancel the pending close');
});

test('a deliberate detachTab of the last tab closes the session at once', async () => {
  const RelayConnection = await loadRelayConnection();
  installChromeMock();
  const socket = new FakeSocket();
  const connection = new RelayConnection(socket);

  await attachTab(socket, 42);
  connection.detachTab(42);

  assert.ok(socket.closed, 'pulling the last tab out of the group is a request to end the session');
});

// FB-60. Chrome's "started debugging this browser" infobar is shared by every
// client host of the extension, and its X detaches all of them with
// `canceled_by_user`. Treating that like an incidental detach re-attaches
// against the user's explicit request -- and since Chrome destroys the infobar
// along with the last detach, every re-attach mints a fresh banner. That is the
// endless stack of banners the X never clears.
test('a canceled_by_user detach ends the session at once', async () => {
  const RelayConnection = await loadRelayConnection();
  const mock = installChromeMock();
  const socket = new FakeSocket();
  new RelayConnection(socket);

  await attachTab(socket, 42);
  mock.debugger.onDetach.fire({ tabId: 42 }, 'canceled_by_user');

  assert.ok(socket.closed, 'dismissing the debugging banner is a request to stop debugging');
});

// The watch is what keeps a detached tab eligible for re-attachment. A user
// cancel must not arm it, or the session lingers waiting to come back.
test('a canceled_by_user detach does not wait out the reattach watch', async () => {
  const RelayConnection = await loadRelayConnection();
  const mock = installChromeMock();
  const socket = new FakeSocket();
  new RelayConnection(socket, { detachedTabWatchMs: 60_000 });

  await attachTab(socket, 42);
  mock.debugger.onDetach.fire({ tabId: 42 }, 'canceled_by_user');
  await wait(50);

  assert.ok(socket.closed, 'a user cancel must not be held open by the reattach watch');
});

// One cancelled tab is the user speaking for the whole session: Chrome has
// already detached every tab this client held.
test('a canceled_by_user detach of one tab ends a multi-tab session', async () => {
  const RelayConnection = await loadRelayConnection();
  const mock = installChromeMock();
  const socket = new FakeSocket();
  new RelayConnection(socket);

  await attachTab(socket, 42);
  await attachTab(socket, 43, 2);
  mock.debugger.onDetach.fire({ tabId: 42 }, 'canceled_by_user');

  assert.ok(socket.closed, 'the banner covers the whole client, not one tab');
});
