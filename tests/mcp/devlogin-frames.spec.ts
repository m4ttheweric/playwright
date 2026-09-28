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

import { test, expect, devLoginRequests } from './fixtures';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

const PASSWORD = 'devlogin:login.example.com:password';
const VALUE = 'Sup3r secret&+';
const INPUT = `<input id="pw" type="password" aria-label="pw" oninput="console.log('typed:' + this.value)">`;

async function typedLines(client: Client) {
  const response = await client.callTool({ name: 'browser_console_messages' });
  return JSON.stringify(response.content).match(/typed:(?:(?! @ )[^"\\])*/g) ?? [];
}

async function frameRef(client: Client) {
  const snapshot = JSON.stringify((await client.callTool({ name: 'browser_snapshot', arguments: {} })).content);
  return /textbox \\"pw\\" \[ref=(f\d+e\d+)\]/.exec(snapshot)![1];
}

function login(origin: string) {
  return [{ name: PASSWORD, origin, kind: 'password' as const, value: VALUE }];
}

function htmlAttribute(markup: string) {
  return markup.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

async function fillInFrame(client: Client) {
  return await client.callTool({
    name: 'browser_fill_form',
    arguments: { fields: [{ name: 'Password', type: 'textbox', target: await frameRef(client), value: PASSWORD }] },
  });
}

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'chrome', 'CDP frame tree');
});

test('a cross-origin iframe reports its own origin, not the page origin', async ({ startClient, server }) => {
  const pageOrigin = new URL(server.PREFIX).origin;
  const frameOrigin = new URL(server.CROSS_PROCESS_PREFIX).origin;
  const { client } = await startClient({ devLogins: { logins: login(pageOrigin) } });
  server.setContent('/frame.html', INPUT, 'text/html');
  server.setContent('/', `<iframe src="${server.CROSS_PROCESS_PREFIX}/frame.html"></iframe>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(await fillInFrame(client)).toHaveResponse({ isError: true, error: expect.stringContaining('refused: mismatch') });
  expect(devLoginRequests().map(r => r.frameOrigin)).toEqual([frameOrigin]);
  expect(await typedLines(client)).toEqual([]);
});

for (const [kind, markup] of [
  ['sandboxed', (prefix: string) => `<iframe sandbox="allow-scripts" src="${prefix}/frame.html"></iframe>`],
  ['script-less sandboxed', (prefix: string) => `<iframe sandbox src="${prefix}/frame.html"></iframe>`],
  ['srcdoc', () => `<iframe srcdoc="${htmlAttribute(INPUT)}"></iframe>`],
  ['about:blank', () => `<iframe id="f"></iframe><script>document.getElementById('f').contentDocument.body.innerHTML = ${JSON.stringify(INPUT)};</script>`],
  ['blob:', () => `<iframe id="f"></iframe><script>document.getElementById('f').src = URL.createObjectURL(new Blob([${JSON.stringify(INPUT)}], { type: 'text/html' }));</script>`],
] as const) {
  test(`a ${kind} frame is refused as opaque before any request`, async ({ startClient, server }) => {
    const origin = new URL(server.PREFIX).origin;
    const { client } = await startClient({ devLogins: { logins: login(origin) } });
    server.setContent('/frame.html', INPUT, 'text/html');
    server.setContent('/', markup(server.PREFIX), 'text/html');
    await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
    expect(await fillInFrame(client)).toHaveResponse({ isError: true, error: expect.stringContaining('refused: opaque-origin') });
    expect(devLoginRequests()).toEqual([]);
    expect(await typedLines(client)).toEqual([]);
  });
}

test('a password placeholder on a text input sends elementKind text and is refused', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({ devLogins: { logins: login(origin) } });
  server.setContent('/', `<input id="t" type="text" oninput="console.log('typed:' + this.value)">`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(await client.callTool({
    name: 'browser_type',
    arguments: { element: 't', target: '#t', text: PASSWORD },
  })).toHaveResponse({ isError: true, error: expect.stringContaining('refused: mismatch') });
  expect(devLoginRequests().map(r => r.elementKind)).toEqual(['text']);
  expect(await typedLines(client)).toEqual([]);
});

test('the page navigating while a reply is in flight types nothing', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({ devLogins: { logins: login(origin), delayMs: 1_000 } });
  server.setContent('/next', `<p>next</p>`, 'text/html');
  server.setContent('/', `${INPUT}<script>document.getElementById('pw').addEventListener('focus', () => {}); setTimeout(() => location.href = '/next', 300);</script>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const response = await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: PASSWORD } });
  expect(response.isError).toBe(true);
  expect(await typedLines(client)).toEqual([]);
  expect(JSON.stringify(response.content)).not.toContain('Sup3r');
});

test('the lock works when attached over --cdp-endpoint', async ({ startClient, server, cdpServer }) => {
  await cdpServer.start();
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`], devLogins: { logins: login(origin) } });
  server.setContent('/', INPUT, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: PASSWORD } });
  expect(devLoginRequests().map(r => r.frameOrigin)).toEqual([origin]);
  expect(await typedLines(client)).toEqual([`typed:<secret>${PASSWORD}</secret>`]);
});

test('a cross-origin iframe that keeps grabbing focus receives nothing from repeated fills', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({ devLogins: { logins: login(origin) } });
  server.setContent('/frame.html', `<input id="grab" oninput="console.log('typed:' + this.value)">
    <script>
      const input = document.getElementById('grab');
      setInterval(() => input.focus(), 0);
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { input.focus(); channel.port2.postMessage(0); };
      channel.port2.postMessage(0);
    </script>`, 'text/html');
  server.setContent('/', `<input id="pw" type="password" oninput="console.log('length:' + this.value.length)">
    <iframe src="${server.CROSS_PROCESS_PREFIX}/frame.html"></iframe>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_wait_for', arguments: { time: 0.3 } });
  for (let i = 0; i < 5; i++) {
    const response = await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: PASSWORD } });
    expect(response.isError).toBeFalsy();
  }
  const messages = JSON.stringify((await client.callTool({ name: 'browser_console_messages' })).content);
  expect(await typedLines(client)).toEqual([]);
  expect(messages.match(/length:\d+/g)).toEqual(Array(5).fill(`length:${VALUE.length}`));
});

test('a controlled input tracking its value through the property setter sees the fill', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({ devLogins: { logins: login(origin) } });
  server.setContent('/', `<input id="pw" type="password">
    <script>
      const input = document.getElementById('pw');
      const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      let tracked = input.value;
      Object.defineProperty(input, 'value', {
        get() { return native.get.call(this); },
        set(v) { tracked = String(v); native.set.call(this, v); },
      });
      input.addEventListener('input', () => {
        if (input.value !== tracked) {
          tracked = input.value;
          console.log('changed:' + input.value.length);
        }
      });
    </script>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const response = await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: PASSWORD } });
  expect(response.isError).toBeFalsy();
  const messages = JSON.stringify((await client.callTool({ name: 'browser_console_messages' })).content);
  expect(messages.match(/changed:\d+/g)).toEqual([`changed:${VALUE.length}`]);
});

test('an approved fill that fails inside the page reports no form of the value', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({
    args: ['--timeout-action=1000'],
    devLogins: { logins: login(origin) },
  });
  server.setContent('/', `<input id="pw" type="password" disabled>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const response = await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: PASSWORD } });
  expect(response.isError).toBe(true);
  expect(devLoginRequests().map(r => r.frameOrigin)).toEqual([origin]);
  // Every raw, URI, form, JSON and HTML encoding of VALUE starts with this prefix.
  expect(JSON.stringify(response.content)).not.toContain('Sup3r');
});

test('a fill with --save-video on is refused as recording and sends nothing', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({
    args: ['--save-video=800x600', `--output-dir=${test.info().outputPath('output')}`],
    devLogins: { logins: login(origin) },
  });
  server.setContent('/', INPUT, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(await client.callTool({
    name: 'browser_type',
    arguments: { element: 'pw', target: '#pw', text: PASSWORD },
  })).toHaveResponse({ isError: true, error: expect.stringContaining('refused: recording') });
  expect(devLoginRequests()).toEqual([]);
  expect(await typedLines(client)).toEqual([]);
});

test('a fill with recordVideo in the config context options is refused as recording', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({
    config: { browser: { contextOptions: { recordVideo: { dir: test.info().outputPath('videos') } } } },
    devLogins: { logins: login(origin) },
  });
  server.setContent('/', INPUT, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(await client.callTool({
    name: 'browser_type',
    arguments: { element: 'pw', target: '#pw', text: PASSWORD },
  })).toHaveResponse({ isError: true, error: expect.stringContaining('refused: recording') });
  expect(devLoginRequests()).toEqual([]);
  expect(await typedLines(client)).toEqual([]);
});

test('a fill with recordHar in the config context options is refused as recording', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({
    config: { browser: { contextOptions: { recordHar: { path: test.info().outputPath('network.har') } } } },
    devLogins: { logins: login(origin) },
  });
  server.setContent('/', INPUT, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(await client.callTool({
    name: 'browser_type',
    arguments: { element: 'pw', target: '#pw', text: PASSWORD },
  })).toHaveResponse({ isError: true, error: expect.stringContaining('refused: recording') });
  expect(devLoginRequests()).toEqual([]);
  expect(await typedLines(client)).toEqual([]);
});

test('a fill during a trace started from browser_run_code_unsafe is refused as recording', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({ devLogins: { logins: login(origin) } });
  server.setContent('/', INPUT, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const started = await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: `async page => { await page.context().tracing.start({ snapshots: true }); }` } });
  expect(started.isError).toBeFalsy();
  expect(await client.callTool({
    name: 'browser_type',
    arguments: { element: 'pw', target: '#pw', text: PASSWORD },
  })).toHaveResponse({ isError: true, error: expect.stringContaining('refused: recording') });
  expect(devLoginRequests()).toEqual([]);
  expect(await typedLines(client)).toEqual([]);
  const stopped = await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: `async page => { await page.context().tracing.stop(); }` } });
  expect(stopped.isError).toBeFalsy();
  expect((await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: PASSWORD } })).isError).toBeFalsy();
  expect(await typedLines(client)).toEqual([`typed:<secret>${PASSWORD}</secret>`]);
});

test('a fill during a browser_start_video recording is refused as recording', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({
    args: ['--caps=devtools', `--output-dir=${test.info().outputPath('output')}`],
    devLogins: { logins: login(origin) },
  });
  server.setContent('/', INPUT, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const started = await client.callTool({ name: 'browser_start_video', arguments: {} });
  expect(started.isError).toBeFalsy();
  expect(await client.callTool({
    name: 'browser_type',
    arguments: { element: 'pw', target: '#pw', text: PASSWORD },
  })).toHaveResponse({ isError: true, error: expect.stringContaining('refused: recording') });
  expect(devLoginRequests()).toEqual([]);
  expect(await typedLines(client)).toEqual([]);
});

test('a fill during a browser_start_tracing trace is refused as recording', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({
    args: ['--caps=devtools', `--output-dir=${test.info().outputPath('output')}`],
    devLogins: { logins: login(origin) },
  });
  server.setContent('/', INPUT, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const started = await client.callTool({ name: 'browser_start_tracing', arguments: {} });
  expect(started.isError).toBeFalsy();
  expect(await client.callTool({
    name: 'browser_type',
    arguments: { element: 'pw', target: '#pw', text: PASSWORD },
  })).toHaveResponse({ isError: true, error: expect.stringContaining('refused: recording') });
  expect(devLoginRequests()).toEqual([]);
  expect(await typedLines(client)).toEqual([]);
});
