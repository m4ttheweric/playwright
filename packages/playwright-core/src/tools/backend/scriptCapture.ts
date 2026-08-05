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

import type { TraceScriptAction, TraceTruncationMarker } from './traceLog';

// browser_run_code_unsafe (runCode.ts) captures Playwright API actions via a
// ClientInstrumentation listener on `tab.page._instrumentation`. That object
// is NOT per-page or per-connection: it comes from one Connection created
// once at process start (packages/playwright-core/src/inprocess.ts's
// module-level `export const playwright = createInProcessPlaywright()`), and
// every BrowserBackend in the process is handed the same Connection's
// `_instrumentation` Proxy. A single MCP server process serves multiple
// client connections over its lifetime -- each connecting client gets its
// own BrowserBackend (see tools/mcp/program.ts's `factory.create`, invoked
// once per connection) but they all share this one instrumentation object.
//
// The instrumentation hook gives no way to attribute an event back to the
// page/script that caused it: ClientInstrumentationListener.onApiCallBegin
// receives only `apiCall: ApiCallData` (apiName/title/frames/userData/
// stepId/error -- clientInstrumentation.ts:24-31) and `channel: { type,
// method, params }` (clientInstrumentation.ts:37). Neither carries a
// reference to the ChannelOwner instance that made the call, or any page/
// frame guid -- the invoking object (`this` inside `_createChannel`'s proxy
// trap, channelOwner.ts:171) is never forwarded. Locator methods make this
// concretely unrecoverable even from `channel.type`: `Locator.click()`
// delegates through `this._frame._channel.click(...)` (locator.ts:115),
// i.e. the channel owner reported is the Frame, not the Locator, with
// nothing identifying *which* frame. Recovering real attribution would mean
// monkey-patching ChannelOwner/Locator/Frame internals -- a value-level
// change to src/client/**, outside this backend's DEPS allow-list, and well
// past "read an already-live object's field" territory.
//
// So: correctness over completeness. Track how many browser_run_code_unsafe
// calls are capturing concurrently, process-wide (not per-Context, since the
// contamination risk isn't scoped to one Context either). If a second
// capture begins while an earlier one is still open, both may now receive
// each other's onApiCallBegin events with no way to separate them -- so both
// are marked contaminated and both report the documented opaque fallback
// (`actions: []`) instead of risking silently merged data.
export type ScriptCapture = {
  actions: TraceScriptAction[];
  contaminated: boolean;
  // Count of onApiCallBegin events observed after `actions` hit
  // MAX_CAPTURED_ACTIONS. Tracked separately from actions.length so
  // endScriptCapture can report an honest omittedElements count without
  // having reserved (and then discarded) the entries themselves.
  omitted: number;
};

// A script that drives a tight loop of Playwright API calls (e.g. clicking
// through a few thousand rows) can otherwise grow `actions` unboundedly for
// as long as the run_code call is in flight -- this caps the in-memory
// array itself, independently of (and ahead of) the write-time 64 KB
// truncation in traceLog.ts, which only ever sees the already-capped array.
export const MAX_CAPTURED_ACTIONS = 10_000;

const activeCaptures = new Set<ScriptCapture>();

export function beginScriptCapture(): ScriptCapture {
  const capture: ScriptCapture = { actions: [], contaminated: activeCaptures.size > 0, omitted: 0 };
  if (capture.contaminated) {
    for (const other of activeCaptures)
      other.contaminated = true;
  }
  activeCaptures.add(capture);
  return capture;
}

// Called from runCode.ts's onApiCallBegin listener for every observed API
// call. Once the cap is hit, further calls are counted but not retained.
export function recordCapturedAction(capture: ScriptCapture, action: TraceScriptAction): void {
  if (capture.actions.length >= MAX_CAPTURED_ACTIONS) {
    capture.omitted++;
    return;
  }
  capture.actions.push(action);
}

export function endScriptCapture(capture: ScriptCapture): (TraceScriptAction | TraceTruncationMarker)[] {
  activeCaptures.delete(capture);
  if (capture.contaminated)
    return [];
  if (capture.omitted === 0)
    return capture.actions;
  // sizeBytes reports the size of what was actually kept (the capped
  // actions array), not a hypothetical uncapped size -- computing the real
  // size of the omitted tail would mean having retained it, which is
  // exactly what the cap avoids.
  const marker: TraceTruncationMarker = {
    __truncated__: true,
    omittedElements: capture.omitted,
    sizeBytes: Buffer.byteLength(JSON.stringify(capture.actions)),
  };
  return [...capture.actions, marker];
}
