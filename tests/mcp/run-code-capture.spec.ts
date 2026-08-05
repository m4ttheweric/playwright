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

import { test, expect } from './fixtures';

import { tools } from '../../packages/playwright-core/lib/coreBundle';

const { beginScriptCapture, endScriptCapture, recordCapturedAction, MAX_CAPTURED_ACTIONS } = tools;

// Unit-level check for the overlap guard in
// packages/playwright-core/src/tools/backend/scriptCapture.ts, which
// browser_run_code_unsafe (runCode.ts) uses to keep concurrent scripts from
// contaminating each other's `actions` array. The realistic trigger --two
// MCP client connections landing in the SAME server process, both running
// browser_run_code_unsafe at once-- can't be reproduced with this suite's
// `startClient` fixture: every call spawns a brand-new child process
// (tests/mcp/fixtures.ts's `createTransport`, always a fresh
// `StdioClientTransport`), so two `startClient()` connections never share
// the process-wide ClientInstrumentation Proxy that makes the bug possible
// in the first place. Exercising the guard's own bookkeeping directly is the
// cheap, deterministic substitute: no browser, no transport, just the exact
// begin/end contract runCode.ts relies on.
test.skip(({ mcpBrowser }) => mcpBrowser !== 'chrome', 'Channel-agnostic; doesn\'t touch a browser at all.');

test('non-overlapping captures keep their own actions', () => {
  const first = beginScriptCapture();
  first.actions.push({ apiName: 'locator.click' });
  expect(endScriptCapture(first)).toEqual([{ apiName: 'locator.click' }]);

  const second = beginScriptCapture();
  second.actions.push({ apiName: 'locator.textContent' });
  expect(endScriptCapture(second)).toEqual([{ apiName: 'locator.textContent' }]);
});

test('a capture that begins while another is still open contaminates both', () => {
  const first = beginScriptCapture();
  const second = beginScriptCapture(); // overlaps with `first` -- neither can trust its actions now.
  first.actions.push({ apiName: 'locator.click' });
  second.actions.push({ apiName: 'page.title' });

  // Both report the documented opaque fallback, not a merge of each other's actions.
  expect(endScriptCapture(first)).toEqual([]);
  expect(endScriptCapture(second)).toEqual([]);
});

test('a third capture starting after the first ends is unaffected by an earlier overlap', () => {
  const first = beginScriptCapture();
  const second = beginScriptCapture(); // contaminates `first` and `second`.
  expect(endScriptCapture(first)).toEqual([]);
  expect(endScriptCapture(second)).toEqual([]);

  const third = beginScriptCapture(); // begins only after both prior captures ended -- no overlap.
  third.actions.push({ apiName: 'locator.fill' });
  expect(endScriptCapture(third)).toEqual([{ apiName: 'locator.fill' }]);
});

// Fold-in minor from the WS1 fix wave: an unbounded run_code loop must not
// grow `actions` without limit while the script is in flight. Exercises
// recordCapturedAction directly rather than pushing MAX_CAPTURED_ACTIONS + N
// real Playwright API calls through a browser, which would be both slow and
// indirect for what is purely an in-memory bookkeeping cap.
test('capture caps in-memory actions and reports omitted entries via a trailing truncation marker', () => {
  const capture = beginScriptCapture();
  for (let i = 0; i < MAX_CAPTURED_ACTIONS + 5; i++)
    recordCapturedAction(capture, { apiName: 'locator.click', params: { i } });

  const actions = endScriptCapture(capture);
  expect(actions.length).toBe(MAX_CAPTURED_ACTIONS + 1); // capped entries + one marker
  const kept = actions.slice(0, -1) as { apiName: string, params: { i: number } }[];
  expect(kept.length).toBe(MAX_CAPTURED_ACTIONS);
  // Kept entries are the first MAX_CAPTURED_ACTIONS observed, in order --
  // dropped entries come from the end, not scattered.
  expect(kept[0].params.i).toBe(0);
  expect(kept[kept.length - 1].params.i).toBe(MAX_CAPTURED_ACTIONS - 1);

  const marker = actions[actions.length - 1] as any;
  expect(marker.__truncated__).toBe(true);
  expect(marker.omittedElements).toBe(5);
  expect(typeof marker.sizeBytes).toBe('number');
});

test('a capture that never hits the cap reports no marker', () => {
  const capture = beginScriptCapture();
  recordCapturedAction(capture, { apiName: 'page.title' });
  const actions = endScriptCapture(capture);
  expect(actions).toEqual([{ apiName: 'page.title' }]);
});

test('overlap is detected even when the later capture ends first', () => {
  const first = beginScriptCapture();
  const second = beginScriptCapture(); // overlaps with `first`.
  second.actions.push({ apiName: 'page.title' });
  // `second` ends before `first` does -- `first` is still marked contaminated
  // regardless of end order, since the risk (mixed onApiCallBegin delivery)
  // existed for the whole time both were open.
  expect(endScriptCapture(second)).toEqual([]);

  first.actions.push({ apiName: 'locator.click' });
  expect(endScriptCapture(first)).toEqual([]);
});
