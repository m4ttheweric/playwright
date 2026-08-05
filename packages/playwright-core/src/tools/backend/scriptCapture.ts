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

import type { TraceScriptAction } from './traceLog';

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
};

const activeCaptures = new Set<ScriptCapture>();

export function beginScriptCapture(): ScriptCapture {
  const capture: ScriptCapture = { actions: [], contaminated: activeCaptures.size > 0 };
  if (capture.contaminated) {
    for (const other of activeCaptures)
      other.contaminated = true;
  }
  activeCaptures.add(capture);
  return capture;
}

export function endScriptCapture(capture: ScriptCapture): TraceScriptAction[] {
  activeCaptures.delete(capture);
  return capture.contaminated ? [] : capture.actions;
}
