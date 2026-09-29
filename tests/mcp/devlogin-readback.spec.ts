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

import type { StartClient } from './fixtures';
import type { TestServer } from '../config/testserver';

const PASSWORD = 'devlogin:login.example.com:password';
const READBACK = [
  { name: 'browser_evaluate', arguments: { function: '() => document.getElementById("pw")?.value' } },
  { name: 'browser_run_code_unsafe', arguments: { code: 'async page => page.inputValue("#pw")' } },
  { name: 'browser_network_requests', arguments: {} },
  { name: 'browser_network_request', arguments: { index: 1 } },
  { name: 'browser_take_screenshot', arguments: {} },
];
const RECORDING = [
  { name: 'browser_start_tracing', arguments: {} },
  { name: 'browser_start_video', arguments: {} },
];
const RENDERING = [
  { name: 'browser_pdf_save', arguments: {} },
  { name: 'browser_annotate', arguments: {} },
];

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'chrome', 'CDP frame tree');
});

async function filledClient(startClient: StartClient, server: TestServer, page: string, args?: string[]) {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({
    args,
    devLogins: { logins: [{ name: PASSWORD, origin, kind: 'password', value: 'Sup3r secret&+' }] },
  });
  server.setContent('/', page, 'text/html');
  server.setContent('/app', '<p>app</p><input id="pw" type="password">', 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: PASSWORD } });
  return client;
}

function recordingArgs() {
  return ['--caps=devtools,pdf', `--output-dir=${test.info().outputPath('output')}`];
}

test('readback tools are refused while the filled value is on the page', async ({ startClient, server }) => {
  const client = await filledClient(startClient, server, '<input id="pw" type="password">');
  for (const call of READBACK) {
    expect(await client.callTool(call), call.name).toHaveResponse({
      isError: true,
      error: expect.stringContaining('unavailable until the page leaves the saved login'),
    });
  }
});

test('readback is allowed again after the filled frame navigates, on the same origin', async ({ startClient, server }) => {
  const client = await filledClient(startClient, server, '<input id="pw" type="password">');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/app' } });
  for (const call of READBACK)
    expect(JSON.stringify((await client.callTool(call)).content), call.name).not.toContain('unavailable until the page leaves');
});

test('readback is allowed again after the filled element detaches', async ({ startClient, server }) => {
  const client = await filledClient(startClient, server, '<input id="pw" type="password"><button id="rm" onclick="document.getElementById(\'pw\').remove()">rm</button>');
  await client.callTool({ name: 'browser_click', arguments: { element: 'rm', target: '#rm' } });
  const response = await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => 1' } });
  expect(response.isError).toBeFalsy();
});

test('a same-document navigation keeps the lock', async ({ startClient, server }) => {
  const client = await filledClient(startClient, server, '<input id="pw" type="password"><button id="p" onclick="history.pushState({}, \'\', \'/step2\')">p</button>');
  await client.callTool({ name: 'browser_click', arguments: { element: 'p', target: '#p' } });
  expect(await client.callTool(READBACK[0])).toHaveResponse({ isError: true, error: expect.stringContaining('unavailable until the page leaves') });
});

test('recordings and page renders cannot start while the filled value is on the page', async ({ startClient, server }) => {
  const client = await filledClient(startClient, server, '<input id="pw" type="password">', recordingArgs());
  for (const call of [...RECORDING, ...RENDERING]) {
    expect(await client.callTool(call), call.name).toHaveResponse({
      isError: true,
      error: expect.stringContaining('unavailable until the page leaves the saved login'),
    });
  }
});

test('recordings can start again after the filled frame navigates', async ({ startClient, server }) => {
  const client = await filledClient(startClient, server, '<input id="pw" type="password">', recordingArgs());
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/app' } });
  for (const call of RECORDING) {
    const response = await client.callTool(call);
    expect(response.isError, call.name).toBeFalsy();
  }
});

test('readback stays refused while any filled element remains', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const email = 'devlogin:login.example.com:email';
  const { client } = await startClient({
    devLogins: { logins: [
      { name: email, origin, kind: 'email', value: 'user@login.example.com' },
      { name: PASSWORD, origin, kind: 'password', value: 'Sup3r secret&+' },
    ] },
  });
  server.setContent('/', `<input id="em" type="email"><input id="pw" type="password">
    <button id="rmpw" onclick="document.getElementById('pw').remove()">rmpw</button>
    <button id="rmem" onclick="document.getElementById('em').remove()">rmem</button>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const filled = await client.callTool({
    name: 'browser_fill_form',
    arguments: { fields: [
      { name: 'Email', type: 'textbox', target: '#em', value: email },
      { name: 'Password', type: 'textbox', target: '#pw', value: PASSWORD },
    ] },
  });
  expect(filled.isError).toBeFalsy();
  await client.callTool({ name: 'browser_click', arguments: { element: 'rmpw', target: '#rmpw' } });
  expect(await client.callTool(READBACK[0])).toHaveResponse({ isError: true, error: expect.stringContaining('unavailable until the page leaves') });
  await client.callTool({ name: 'browser_click', arguments: { element: 'rmem', target: '#rmem' } });
  expect((await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => 1' } })).isError).toBeFalsy();
});

test('an open dialog keeps readback refused without hanging', async ({ startClient, server }) => {
  const client = await filledClient(startClient, server, '<input id="pw" type="password"><button id="a" onclick="alert(\'hi\')">a</button>');
  await client.callTool({ name: 'browser_click', arguments: { element: 'a', target: '#a' } });
  const started = Date.now();
  expect(await client.callTool(READBACK[0])).toHaveResponse({ isError: true, error: expect.stringContaining('unavailable until the page leaves') });
  expect(Date.now() - started).toBeLessThan(5000);
});

test('a javascript: navigation is refused while the filled value is on the page', async ({ startClient, server }) => {
  const client = await filledClient(startClient, server, '<title>orig</title><input id="pw" type="password">');
  for (const url of [`javascript:document.title=btoa(document.getElementById('pw').value)`, ` JaVa\tScRiPt:document.title=btoa(document.getElementById('pw').value)`]) {
    expect(await client.callTool({ name: 'browser_navigate', arguments: { url } }), url).toHaveResponse({
      isError: true,
      error: expect.stringContaining('unavailable until the page leaves the saved login'),
    });
  }
  const tabs = JSON.stringify((await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })).content);
  expect(tabs).toContain('[orig]');
  expect(tabs).not.toContain(Buffer.from('Sup3r secret&+').toString('base64'));
});

test('a readback call already running when a fill starts finishes before the value is requested', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const value = 'Sup3r secret&+';
  const { client } = await startClient({ devLogins: { logins: [{ name: PASSWORD, origin, kind: 'password', value }] } });
  server.setContent('/', '<input id="pw" type="password">', 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const script = client.callTool({
    name: 'browser_run_code_unsafe',
    arguments: { code: `async page => { await page.waitForTimeout(1500); return await page.evaluate(() => { const v = document.getElementById('pw').value; return [v.split('').join('|'), btoa(v)]; }); }` },
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  const typed = client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: PASSWORD } });
  const output = JSON.stringify((await script).content);
  expect((await typed).isError).toBeFalsy();
  for (const form of [value, value.split('').join('|'), Buffer.from(value).toString('base64')])
    expect(output).not.toContain(form);
});

test('readback is refused while a fill is waiting for its value', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({
    devLogins: { logins: [{ name: PASSWORD, origin, kind: 'password', value: 'Sup3r secret&+' }], delayMs: 1_500 },
  });
  server.setContent('/', '<input id="pw" type="password">', 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const typed = client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: PASSWORD } });
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(await client.callTool(READBACK[0])).toHaveResponse({ isError: true, error: expect.stringContaining('unavailable until the page leaves') });
  expect((await typed).isError).toBeFalsy();
});

test('a fill that fails after the value arrives keeps readback refused', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({
    args: ['--timeout-action=1000'],
    devLogins: { logins: [{ name: PASSWORD, origin, kind: 'password', value: 'Sup3r secret&+' }] },
  });
  server.setContent('/', '<input id="pw" type="password" disabled>', 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect((await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: PASSWORD } })).isError).toBe(true);
  expect(await client.callTool(READBACK[0])).toHaveResponse({ isError: true, error: expect.stringContaining('unavailable until the page leaves') });
});

test('a refused fill leaves readback open', async ({ startClient, server }) => {
  const { client } = await startClient({ devLogins: { logins: [], refusal: 'unknown' } });
  server.setContent('/', '<input id="pw" type="password">', 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: PASSWORD } })).toHaveResponse({
    isError: true,
    error: expect.stringContaining('refused: unknown'),
  });
  expect((await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => 1' } })).isError).toBeFalsy();
});
