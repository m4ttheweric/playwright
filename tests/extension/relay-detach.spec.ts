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

// Repro matrix for MAT-124: a click that replaces the document kills the whole
// relay session, not just the page. RelayConnection._checkLastTabDetached fires
// on the chrome.debugger.onDetach *event* -- an involuntary, Chrome-initiated
// detach -- and responds by closing the entire WebSocket, the same way it
// responds to a user deliberately pulling the last tab out of the group.
//
// Each test drives one flavour of document replacement and then probes whether
// the session is still usable. The point is to find which flavour detaches, so
// the fix can tell "Chrome yanked the debugger" apart from "the user is done".

import { test, expect, connectAndNavigate } from './extension-fixtures';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

const STEP_TWO = '<title>StepTwo</title><body>Step two reached</body>';

// The relay dying surfaces as either a thrown target-closed error or an error
// response, depending on where the socket close lands relative to the call.
// Collapse both into one verdict so the assertion reads the same either way.
async function sessionIsAlive(client: Client): Promise<{ alive: boolean, detail: string }> {
  try {
    const response = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
    const text = (response as any).content?.[0]?.text ?? '';
    if ((response as any).isError)
      return { alive: false, detail: `error response: ${text}` };
    // A live relay that lost its pages comes back holding only connect.html,
    // which is the exact post-drop state the ticket reports.
    if (text.includes('connect.html'))
      return { alive: false, detail: `session reset to the connect page: ${text}` };
    return { alive: true, detail: text };
  } catch (error: any) {
    return { alive: false, detail: `threw: ${error?.message ?? error}` };
  }
}

async function refForButton(client: Client): Promise<string> {
  const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const text = (snapshot as any).content?.[0]?.text ?? '';
  const match = text.match(/button "go" \[ref=([a-z0-9]+)\]/);
  if (!match)
    throw new Error(`could not find the button ref in snapshot: ${text.slice(0, 400)}`);
  return match[1];
}

async function clickAndProbe(client: Client) {
  const ref = await refForButton(client);
  let clickError = '';
  try {
    const response = await client.callTool({
      name: 'browser_click',
      arguments: { element: 'go', target: ref },
    });
    if ((response as any).isError)
      clickError = (response as any).content?.[0]?.text ?? 'error response';
  } catch (error: any) {
    clickError = error?.message ?? String(error);
  }
  const liveness = await sessionIsAlive(client);
  return { clickError, ...liveness };
}

test(`same-origin navigation from a click keeps the session alive`, async ({ startExtensionClient, server }) => {
  server.setContent('/step-one', `<title>StepOne</title><body><button onclick="location.href='${server.PREFIX}/step-two'">go</button></body>`, 'text/html');
  server.setContent('/step-two', STEP_TWO, 'text/html');
  const { browserContext, client } = await startExtensionClient();
  await connectAndNavigate(browserContext, client, server.PREFIX + '/step-one');

  const { clickError, alive, detail } = await clickAndProbe(client);
  expect(alive, `click error: ${clickError}\nprobe: ${detail}`).toBe(true);
});

test(`cross-origin navigation from a click keeps the session alive`, async ({ startExtensionClient, server }) => {
  server.setContent('/step-one', `<title>StepOne</title><body><button onclick="location.href='${server.CROSS_PROCESS_PREFIX}/step-two'">go</button></body>`, 'text/html');
  server.setContent('/step-two', STEP_TWO, 'text/html');
  const { browserContext, client } = await startExtensionClient();
  await connectAndNavigate(browserContext, client, server.PREFIX + '/step-one');

  const { clickError, alive, detail } = await clickAndProbe(client);
  expect(alive, `click error: ${clickError}\nprobe: ${detail}`).toBe(true);
});

// Closest analogue to the FNOL "I Agree and Continue" step: a real form
// submission replacing the document, rather than a scripted location assign.
test(`form submission from a click keeps the session alive`, async ({ startExtensionClient, server }) => {
  server.setContent('/step-one', `<title>StepOne</title><body><form action="${server.PREFIX}/step-two" method="POST"><input name="who" value="test"><button type="submit">go</button></form></body>`, 'text/html');
  server.setContent('/step-two', STEP_TWO, 'text/html');
  const { browserContext, client } = await startExtensionClient();
  await connectAndNavigate(browserContext, client, server.PREFIX + '/step-one');

  const { clickError, alive, detail } = await clickAndProbe(client);
  expect(alive, `click error: ${clickError}\nprobe: ${detail}`).toBe(true);
});

// The MV3 service worker owns the WebSocket and every bit of RelayConnection
// state, and Chrome evicts it after ~30s idle. The only keepalive lives in
// connect.tsx, whose comment scopes it to "while the user decides" -- and
// background.ts closes that page the moment a tab is picked. So nothing holds
// the worker up for the rest of the session.
//
// These two tests span the same wall-clock and differ only in whether traffic
// flows, which isolates idle time from elapsed time as the variable.
// Both hold a headed Chrome open for 40s, which destabilises the rest of the
// suite when it runs serially (Chrome's singleton behaviour in headed mode).
// They ruled out MV3 worker eviction rather than guarding a behaviour anyone is
// about to change, so they are opt-in: RELAY_SLOW_TESTS=1 npm run test-extension
test(`session survives 40s of idle`, async ({ startExtensionClient, server }) => {
  test.skip(!process.env.RELAY_SLOW_TESTS, 'slow; opt in with RELAY_SLOW_TESTS=1');
  test.setTimeout(120_000);
  server.setContent('/step-one', '<title>StepOne</title><body><button>go</button></body>', 'text/html');
  const { browserContext, client } = await startExtensionClient();
  await connectAndNavigate(browserContext, client, server.PREFIX + '/step-one');

  await new Promise(resolve => setTimeout(resolve, 40_000));

  const { alive, detail } = await sessionIsAlive(client);
  expect(alive, `probe after idle: ${detail}`).toBe(true);
});

test(`session survives 40s of periodic activity`, async ({ startExtensionClient, server }) => {
  test.skip(!process.env.RELAY_SLOW_TESTS, 'slow; opt in with RELAY_SLOW_TESTS=1');
  test.setTimeout(120_000);
  server.setContent('/step-one', '<title>StepOne</title><body><button>go</button></body>', 'text/html');
  const { browserContext, client } = await startExtensionClient();
  await connectAndNavigate(browserContext, client, server.PREFIX + '/step-one');

  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 10_000));
    const probe = await sessionIsAlive(client);
    expect(probe.alive, `probe at ${(i + 1) * 10}s: ${probe.detail}`).toBe(true);
  }
});

// There is deliberately no discard test here. Discarding the attached tab is
// the trigger that produces the harmful detach shape, but `chrome.tabs.discard`
// on a debugger-attached tab takes the entire Chrome process down (measured: 9
// chrome pids before, 0 alive after), so the session dying proves only that the
// browser died. The detach policy itself is covered by
// relay-policy.node.test.mjs, which drives RelayConnection against a fake
// chrome and does not need a browser at all.

// The suspected trigger: the tab the relay is attached to goes away entirely.
// Chrome fires onDetach with target_closed, _checkLastTabDetached sees an empty
// set, and the whole relay is torn down even though a successor tab exists.
test(`click that replaces the tab keeps the session alive`, async ({ startExtensionClient, server }) => {
  server.setContent('/step-one', `<title>StepOne</title><body><button onclick="window.open('${server.PREFIX}/step-two', '_blank'); window.close();">go</button></body>`, 'text/html');
  server.setContent('/step-two', STEP_TWO, 'text/html');
  const { browserContext, client } = await startExtensionClient();
  await connectAndNavigate(browserContext, client, server.PREFIX + '/step-one');

  const { clickError, alive, detail } = await clickAndProbe(client);
  expect(alive, `click error: ${clickError}\nprobe: ${detail}`).toBe(true);
});
