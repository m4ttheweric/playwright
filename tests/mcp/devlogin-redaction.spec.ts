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

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from './fixtures';

const VALUE = `p@ss w&rd+%<>"x'`;
const escapeHtml = (value: string, chars: string, apos = '&#39;') => value.replace(/[&<>"']/g, c => chars.includes(c) ? ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': apos })[c]! : c);
const VARIANTS = [
  VALUE,
  encodeURIComponent(VALUE),
  encodeURIComponent(VALUE).replace(/%20/g, '+'),
  new URLSearchParams({ v: VALUE }).toString().slice(2),
  JSON.stringify(VALUE).slice(1, -1),
  escapeHtml(VALUE, '&<>'),
  escapeHtml(VALUE, '&"'),
  escapeHtml(VALUE, '&"<>'),
  escapeHtml(VALUE, '&<>"\'', '&#39;'),
  escapeHtml(VALUE, '&<>"\'', '&#x27;'),
];

function expectNoVariant(text: string) {
  for (const variant of VARIANTS)
    expect(text).not.toContain(variant);
}

function readTree(dir: string): string {
  let all = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    all += entry.isDirectory() ? readTree(full) : fs.readFileSync(full, 'utf8');
  }
  return all;
}

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

async function startWithSecret(startClient, outputDir: string, extraArgs: string[] = []) {
  const secretsFile = test.info().outputPath('secrets.env');
  await fs.promises.writeFile(secretsFile, `X-PASSWORD=${VALUE}`);
  return await startClient({ args: ['--secrets', secretsFile, `--output-dir=${outputDir}`, ...extraArgs] });
}

const PAGE = `<!DOCTYPE html>
  <script>
    const escapeHtml = (value, chars, apos) => value.replace(/[&<>"']/g, c => chars.includes(c) ? ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": apos })[c] : c);
    function report(value) {
      console.log('uri:' + encodeURIComponent(value));
      console.log('json:' + JSON.stringify({ v: value }));
      const span = document.createElement('span');
      span.title = value;
      console.log('attr:' + span.outerHTML);
      const div = document.createElement('div');
      div.textContent = value;
      console.log('text:' + div.innerHTML);
      console.log('legacy:' + escapeHtml(value, '&"'));
      console.log('full39:' + escapeHtml(value, '&<>"\\'', '&#39;'));
      console.log('full27:' + escapeHtml(value, '&<>"\\'', '&#x27;'));
    }
  </script>
  <form method="POST" action="/login">
    <input id="pw" name="pw" type="text" oninput="report(this.value)">
    <button id="go" type="submit">Go</button>
  </form>`;
const PAGE_GET = PAGE.replace('method="POST"', 'method="GET"');

test('encoded forms of a secret are redacted in console output', async ({ startClient, server }) => {
  const outputDir = test.info().outputPath('output');
  const { client } = await startWithSecret(startClient, outputDir);
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: 'X-PASSWORD' } });
  const response = await client.callTool({ name: 'browser_console_messages' });
  const text = JSON.stringify(response.content);
  expectNoVariant(text);
  expect(text).toContain('<secret>X-PASSWORD</secret>');
});

test('a form-encoded request body is redacted', async ({ startClient, server }) => {
  const outputDir = test.info().outputPath('output');
  const { client } = await startWithSecret(startClient, outputDir);
  server.setContent('/', PAGE, 'text/html');
  server.setContent('/login', 'ok', 'text/plain');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: 'X-PASSWORD' } });
  await client.callTool({ name: 'browser_click', arguments: { element: 'Go', target: '#go' } });
  const list = JSON.stringify((await client.callTool({ name: 'browser_network_requests', arguments: { static: true } })).content);
  const index = Number(/(\d+)\. \[POST\][^\\]*\/login/.exec(list)![1]);
  const body = await client.callTool({ name: 'browser_network_request', arguments: { index, part: 'request-body' } });
  const text = JSON.stringify(body.content);
  expectNoVariant(text);
  expect(text).toContain('<secret>X-PASSWORD</secret>');
});

test('an error message, the trace and the session log are redacted', async ({ startClient, server }) => {
  const outputDir = test.info().outputPath('output');
  const { client } = await startWithSecret(startClient, outputDir, ['--save-trace', '--save-session']);
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: 'X-PASSWORD' } });
  const failed = await client.callTool({
    name: 'browser_run_code_unsafe',
    arguments: { code: `async page => { throw new Error('leak:' + encodeURIComponent(await page.inputValue('#pw'))); }` },
  });
  expect(failed.isError).toBe(true);
  expectNoVariant(JSON.stringify(failed.content));
  await client.close();
  expectNoVariant(readTree(outputDir));
});

test('a text body saved from a binary-typed response is redacted', async ({ startClient, server }) => {
  const outputDir = test.info().outputPath('output');
  const { client } = await startWithSecret(startClient, outputDir);
  server.setRoute('/echo', (req, res) => {
    res.setHeader('content-type', 'application/octet-stream');
    res.end(VALUE);
  });
  server.setContent('/', `<button id="f" onclick="fetch('/echo')">f</button>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_click', arguments: { element: 'f', target: '#f' } });
  const list = JSON.stringify((await client.callTool({ name: 'browser_network_requests', arguments: { static: true } })).content);
  const index = Number(/(\d+)\. \[GET\][^\\]*\/echo/.exec(list)![1]);
  await client.callTool({ name: 'browser_network_request', arguments: { index, part: 'response-body', filename: 'echo.bin' } });
  expectNoVariant(readTree(outputDir));
});

test('trace records and the session log are redacted on their own', async ({ startClient, server }) => {
  const outputDir = test.info().outputPath('output');
  const { client } = await startWithSecret(startClient, outputDir, ['--save-trace', '--save-session']);
  server.setContent('/', PAGE_GET, 'text/html');
  server.setContent('/login', 'ok', 'text/plain');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: 'X-PASSWORD' } });
  await client.callTool({ name: 'browser_click', arguments: { element: 'Go', target: '#go' } });
  await client.callTool({
    name: 'browser_run_code_unsafe',
    arguments: { code: `async page => { await page.title(); } /* ${VALUE} */` },
  });
  await client.close();

  const files = listFiles(outputDir);
  const actions = files.filter(f => path.basename(f) === 'actions.jsonl');
  const sessions = files.filter(f => path.basename(f) === 'session.md');
  expect(actions).toHaveLength(1);
  expect(sessions).toHaveLength(1);
  for (const file of [...actions, ...sessions]) {
    const text = fs.readFileSync(file, 'utf8');
    expectNoVariant(text);
    expect(text).toContain('<secret>X-PASSWORD</secret>');
  }
});
