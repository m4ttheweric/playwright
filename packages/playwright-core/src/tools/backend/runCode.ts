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

// Type-only: the client instrumentation object (`page._instrumentation`) is
// reached at runtime via a property read on the already-live `tab.page`
// (below), not via a value import -- `client/**` is outside this backend's
// DEPS allow-list (only the package root and `src/*` are allowed), and a
// value import would trip `npm run check-deps`. A type-only import is exempt
// from DEPS enforcement (utils/check_deps.js returns before checking the
// import path once it sees the whole ImportClause is type-only), so this is
// the only piece of the client internals reachable from here at all.
import type { ClientInstrumentation, ClientInstrumentationListener } from '../../client/clientInstrumentation';
import type { TraceScriptAction } from './traceLog';

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
    const actions: TraceScriptAction[] = [];
    // `tab.page` is typed against the public API (index.d.ts), which does not
    // expose `_instrumentation` -- it is an internal, per-connection field on
    // ChannelOwner (see client/channelOwner.ts). Reached here via a plain
    // property read on the already-live object, not an import.
    const instrumentation = (tab.page as any)._instrumentation as ClientInstrumentation | undefined;
    const listener: ClientInstrumentationListener = {
      onApiCallBegin: (apiCall, channel) => {
        actions.push({ apiName: apiCall.apiName, params: channel.params });
      },
    };
    instrumentation?.addListener(listener);
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
      tab.context.setScriptTelemetry(epoch, { filename: params.filename, sha256, args: params.args, actions });
    }
  },
});

export default [
  runCode,
];
