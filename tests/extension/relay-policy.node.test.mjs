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

test('an involuntary detach still closes the session when nothing is left to reattach', async () => {
  const RelayConnection = await loadRelayConnection();
  const mock = installChromeMock();
  const socket = new FakeSocket();
  new RelayConnection(socket);

  await attachTab(socket, 42);
  mock.debugger.onDetach.fire({ tabId: 42 }, 'target_closed');
  await wait(kGraceMs + 500);

  assert.ok(socket.closed, 'a session with no surviving tab should still end');
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
