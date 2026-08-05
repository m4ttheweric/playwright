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

import crypto from 'crypto';
import fs from 'fs';
import vm from 'vm';

import * as z from 'zod';
import { ManualPromise } from '@isomorphic/manualPromise';

import { defineTabTool } from './tool';
import { beginScriptCapture, endScriptCapture } from './scriptCapture';

import type { ScriptCapture } from './scriptCapture';

// Type-only: the client instrumentation object (`page._instrumentation`) is
// reached at runtime via a property read on the already-live `tab.page`
// (below), not via a value import -- `client/**` is outside this backend's
// DEPS allow-list (only the package root and `src/*` are allowed), and a
// value import would trip `npm run check-deps`. A type-only import is exempt
// from DEPS enforcement (utils/check_deps.js returns before checking the
// import path once it sees the whole ImportClause is type-only), so this is
// the only piece of the client internals reachable from here at all.
import type { ClientInstrumentation, ClientInstrumentationListener } from '../../client/clientInstrumentation';

const codeSchema = z.object({
  code: z.string().optional().describe(`A JavaScript function containing Playwright code to execute. It will be invoked with a single argument, page, which you can use for any page interaction. For example: \`async (page) => { await page.getByRole('button', { name: 'Submit' }).click(); return await page.title(); }\``),
  filename: z.string().optional().describe('Load code from the specified file. If both code and filename are provided, code will be ignored.'),
  args: z.record(z.string(), z.unknown()).optional().describe('Optional JSON object passed to the function as its second argument, e.g. for parameterizing a script loaded via filename.'),
});

const runCode = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_run_code_unsafe',
    title: 'Run Playwright code (unsafe)',
    description: 'Run a Playwright code snippet. Unsafe: executes arbitrary JavaScript in the Playwright server process and is RCE-equivalent.',
    inputSchema: codeSchema,
    type: 'action',
  },

  handle: async (tab, params, response) => {
    let code = params.code;
    if (params.filename) {
      const resolvedPath = await response.resolveClientFilename(params.filename);
      code = await fs.promises.readFile(resolvedPath, 'utf-8');
    }
    response.addCode(params.args !== undefined
      ? `await (${code})(page, ${JSON.stringify(params.args)});`
      : `await (${code})(page);`);
    const sha256 = crypto.createHash('sha256').update(code ?? '').digest('hex');
    // Captured up front, same reasoning as waitForCompletion's own epoch
    // capture in utils.ts: setScriptTelemetry below must tag its write with
    // the epoch this call actually started under.
    const epoch = tab.context.currentActionEpoch();
    // `tab.page` is typed against the public API (index.d.ts), which does not
    // expose `_instrumentation` -- it is an internal field on ChannelOwner
    // (see client/channelOwner.ts) shared process-wide, not per-page or
    // per-connection (see scriptCapture.ts for why that matters and how
    // `capture` guards against it). Reached here via a plain property read on
    // the already-live object, not an import.
    const instrumentation = (tab.page as any)._instrumentation as ClientInstrumentation | undefined;
    // Assigned inside the try below, not here -- see the comment at that
    // assignment for why (leak risk in scriptCapture.ts's process-wide
    // activeCaptures Set otherwise).
    let capture: ScriptCapture | undefined;
    const listener: ClientInstrumentationListener = {
      onApiCallBegin: (apiCall, channel) => {
        // `_instrumentation` is one Proxy shared by every BrowserBackend in
        // the process (scriptCapture.ts); its dispatch loop
        // (clientInstrumentation.ts's `for (const listener of listeners) ...`)
        // is synchronous and unguarded, so a throw here would break every
        // OTHER in-flight API call being reported process-wide, not just
        // this one. Best-effort capture only. `capture` is read via the
        // closure and may still be undefined for the brief window before the
        // try below assigns it, hence the optional chain.
        try {
          capture?.actions.push({ apiName: apiCall.apiName, params: channel.params });
        } catch {
        }
      },
    };
    const __end__ = new ManualPromise<void>();
    const context: any = {
      page: tab.page,
      __args__: params.args,
      __end__,
    };
    vm.createContext(context);
    // User-installed callbacks (e.g. page.route handlers) can throw
    // asynchronously while __fn__ awaits an operation that depends on them
    // (e.g. a page.evaluate awaiting a fetch the route never fulfills).
    // Settle __end__ on the first such rejection so we unblock instead of
    // waiting for a timeout. The Context-level handler still records it for
    // surfacing on the response.
    const unsubscribe = tab.context.onUnhandledRejection(reason => {
      if (!__end__.isDone())
        __end__.reject(reason instanceof Error ? reason : new Error(String(reason)));
    });
    try {
      // Started here, inside the guarded try, not above it: beginScriptCapture()
      // registers `capture` in scriptCapture.ts's process-wide activeCaptures
      // Set. If it ran before this try (as it originally did) and anything
      // between that call and here threw -- vm.createContext or
      // onUnhandledRejection above are both capable of it in principle --
      // the capture would never reach endScriptCapture() in the finally
      // below, leaking it in the Set forever: every later
      // browser_run_code_unsafe call in this process would then see a
      // phantom overlap and permanently degrade to actions: [], for the life
      // of the process. Same reasoning as addListener just below it.
      capture = beginScriptCapture();
      instrumentation?.addListener(listener);
      await tab.waitForCompletion(async () => {
        // Compile the user function separately to avoid template literal escaping issues
        // when the code contains backticks.
        context.__fn__ = vm.runInContext('(' + code + ')', context);
        const snippet = '(async () => {\n' +
            '  try {\n' +
            '    const result = await __fn__(page, __args__);\n' +
            '    __end__.resolve(JSON.stringify(result));\n' +
            '  } catch (e) {\n' +
            '    __end__.reject(e);\n' +
            '  }\n' +
            '})()';
        const iifePromise = vm.runInContext(snippet, context) as Promise<void>;
        await Promise.race([iifePromise, __end__]);
        const result = await __end__;
        if (typeof result === 'string')
          response.addTextResult(result);
      });
    } finally {
      unsubscribe();
      instrumentation?.removeListener(listener);
      // `capture` is only unset if beginScriptCapture() itself never ran
      // (i.e. this finally is unwinding an exception thrown before reaching
      // it in the try) -- in that case there is nothing registered in
      // activeCaptures to release, so fall back to an empty actions array
      // rather than calling endScriptCapture() on nothing.
      tab.context.setScriptTelemetry(epoch, { filename: params.filename, sha256, args: params.args, actions: capture ? endScriptCapture(capture) : [] });
    }
  },
});

export default [
  runCode,
];
