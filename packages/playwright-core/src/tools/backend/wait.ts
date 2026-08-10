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

import * as z from 'zod';
import { defineTool } from './tool';

const loadStates = ['load', 'domcontentloaded', 'networkidle'] as const;

// A URL predicate is a glob only when it carries glob syntax. A bare string is
// a substring, because that is what a caller who types `/checkout` means, and
// reading it as a glob would silently match nothing forever: globs are
// anchored, so `/checkout` matches only a URL that IS `/checkout`.
const globSyntax = /[*?[\]{}]/;

const wait = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_wait_for',
    title: 'Wait for',
    description: 'Wait for a condition on the page: text appearing or disappearing, the URL changing, a function returning truthy, a load state, or a fixed time',
    inputSchema: z.object({
      time: z.number().optional().describe('The time to wait in seconds'),
      text: z.string().optional().describe('The text to wait for. Only a VISIBLE match counts, so a hidden copy of the same text elsewhere on the page does not end the wait'),
      textGone: z.string().optional().describe('The text to wait for to disappear. Satisfied when no VISIBLE copy of the text remains'),
      url: z.string().optional().describe('URL to wait for. A plain string matches as a substring of the URL; a string containing *, ?, [] or {} matches as a glob'),
      fn: z.string().optional().describe('() => { /* code */ } evaluated in the page, repeatedly, until it returns a truthy value'),
      load: z.enum(loadStates).optional().describe('Load state to wait for'),
      timeout: z.number().optional().describe('How long to wait, in seconds, before giving up. Applies to each condition given. Defaults to the configured action timeout (5 seconds)'),
    }),
    type: 'assertion',
  },

  handle: async (context, params, response) => {
    if (!params.text && !params.textGone && !params.time && !params.url && !params.fn && !params.load)
      throw new Error('Either time, text, textGone, url, fn or load must be provided');

    if (params.time) {
      response.addCode(`await new Promise(f => setTimeout(f, ${params.time!} * 1000));`);
      await new Promise(f => setTimeout(f, Math.min(30000, params.time! * 1000)));
    }

    const tab = context.currentTabOrDie();
    // An explicit timeout replaces the action timeout wholesale rather than
    // capping it, so a caller who knows a page is slow can wait longer than the
    // 5s default, and one who knows it is fast can fail in 1s instead of
    // parking for 5. Without it the only lever was re-invoking the tool.
    const timeoutOptions = params.timeout !== undefined ? { timeout: params.timeout * 1000 } : tab.actionTimeoutOptions;
    const waited: string[] = [];

    if (params.time)
      waited.push(`${params.time} seconds`);

    if (params.load) {
      response.addCode(`await page.waitForLoadState(${JSON.stringify(params.load)});`);
      await tab.page.waitForLoadState(params.load, timeoutOptions);
      waited.push(`load state ${JSON.stringify(params.load)}`);
    }

    if (params.url) {
      const url = params.url;
      if (globSyntax.test(url)) {
        response.addCode(`await page.waitForURL(${JSON.stringify(url)});`);
        await tab.page.waitForURL(url, timeoutOptions);
      } else {
        response.addCode(`await page.waitForURL(url => url.href.includes(${JSON.stringify(url)}));`);
        await tab.page.waitForURL(candidate => candidate.href.includes(url), timeoutOptions);
      }
      waited.push(`URL matching ${JSON.stringify(url)}`);
    }

    if (params.fn) {
      // Same string-or-function convention as browser_evaluate: the caller
      // writes `() => ...` and it gets called, but a bare expression also
      // works. Handing the string straight to waitForFunction would not do:
      // Playwright treats a string as an expression, and the expression
      // `() => false` evaluates to a function object, which is truthy on the
      // very first poll.
      response.addCode(`await page.waitForFunction(${JSON.stringify(params.fn)});`);
      await tab.page.waitForFunction(expression => {
        const value = eval(`(${expression})`);
        const result = typeof value === 'function' ? value() : value;
        // A promise is truthy, so polling on one would report success on the
        // first tick no matter what the predicate eventually resolves to. That
        // is the silent-wrong-answer failure this tool exists to avoid, so an
        // async predicate is refused out loud instead.
        if (result && typeof result.then === 'function')
          throw new Error('browser_wait_for(fn) needs a synchronous predicate: an async function returns a promise, which is always truthy');
        return result;
      }, params.fn, timeoutOptions);
      waited.push(`function to return a truthy value`);
    }

    // `.filter({ visible: true })` goes before `.first()`, never after: the
    // filter is what makes "first" mean the first match a user can actually
    // see. The old `getByText(t).first()` latched the first match in DOM order
    // even when it was hidden, which made an appearing text unwaitable and a
    // disappearing one look like it had already gone.
    if (params.textGone) {
      response.addCode(`await page.getByText(${JSON.stringify(params.textGone)}).filter({ visible: true }).first().waitFor({ state: 'hidden' });`);
      await tab.page.getByText(params.textGone).filter({ visible: true }).first().waitFor({ state: 'hidden', ...timeoutOptions });
      waited.push(`text ${JSON.stringify(params.textGone)} to disappear`);
    }

    if (params.text) {
      response.addCode(`await page.getByText(${JSON.stringify(params.text)}).filter({ visible: true }).first().waitFor({ state: 'visible' });`);
      await tab.page.getByText(params.text).filter({ visible: true }).first().waitFor({ state: 'visible', ...timeoutOptions });
      waited.push(`text ${JSON.stringify(params.text)}`);
    }

    response.addTextResult(`Waited for ${waited.join(', ')}`);
    response.setIncludeSnapshot();
  },
});

export default [
  wait,
];
