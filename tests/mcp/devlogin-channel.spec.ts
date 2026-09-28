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

const EMAIL = 'devlogin:login.example.com:email';
const PASSWORD = 'devlogin:login.example.com:password';

const PAGE = `<!DOCTYPE html>
  <input id="email" type="text" oninput="console.log('typed:' + this.value)">
  <input id="pw" type="password" oninput="console.log('typed:' + this.value)">`;

const LENGTH_PAGE = `<!DOCTYPE html>
  <input id="pw" type="password" oninput="console.log('typed:' + this.value); console.log('length:' + this.value.length)">`;

async function typedLines(client) {
  const response = await client.callTool({ name: 'browser_console_messages' });
  return JSON.stringify(response.content).match(/typed:(?:(?! @ )[^"\\])*/g) ?? [];
}

function logins(origin: string) {
  return [
    { name: EMAIL, origin, kind: 'email' as const, value: 'dev@example.com' },
    { name: PASSWORD, origin, kind: 'password' as const, value: 'Sup3r secret&+' },
  ];
}

test('fills both fields on the matching origin, one request each', async ({ startClient, server }) => {
  test.skip(test.info().project.name !== 'chrome', 'CDP frame tree');
  const origin = new URL(server.PREFIX).origin;
  const { client, stderr } = await startClient({ devLogins: { logins: logins(origin) } });
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(await client.callTool({
    name: 'browser_fill_form',
    arguments: { fields: [
      { name: 'Email', type: 'textbox', target: '#email', value: EMAIL },
      { name: 'Password', type: 'textbox', target: '#pw', value: PASSWORD },
    ] },
  })).toHaveResponse({ code: expect.stringContaining(`fill(process.env['${PASSWORD}'])`) });
  const lines = await typedLines(client);
  expect(lines).toContain(`typed:<secret>${EMAIL}</secret>`);
  expect(lines).toContain(`typed:<secret>${PASSWORD}</secret>`);
  const requests = devLoginRequests();
  expect(requests.map(r => [r.name, r.frameOrigin, r.elementKind])).toEqual([
    [EMAIL, origin, 'text'],
    [PASSWORD, origin, 'password'],
  ]);
  expect(new Set(requests.map(r => r.id)).size).toBe(2);
  expect(stderr()).toContain(`filled saved login for ${origin}`);
  expect(stderr()).not.toContain('Sup3r');
});

test('a refusal from the channel types nothing and names the reason', async ({ startClient, server }) => {
  test.skip(test.info().project.name !== 'chrome', 'CDP frame tree');
  const until = Date.now() + 300_000;
  const { client } = await startClient({ devLogins: { logins: [], refusal: 'limited', until } });
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(await client.callTool({
    name: 'browser_type',
    arguments: { element: 'Password', target: '#pw', text: PASSWORD },
  })).toHaveResponse({ isError: true, error: expect.stringContaining(`refused: limited until ${new Date(until).toISOString()}`) });
  expect(await typedLines(client)).toEqual([]);
});

test('a mismatch reply types nothing', async ({ startClient, server }) => {
  test.skip(test.info().project.name !== 'chrome', 'CDP frame tree');
  const { client } = await startClient({ devLogins: { logins: logins('https://login.example.com') } });
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(await client.callTool({
    name: 'browser_type',
    arguments: { element: 'Password', target: '#pw', text: PASSWORD },
  })).toHaveResponse({ isError: true, error: expect.stringContaining('refused: mismatch') });
  expect(await typedLines(client)).toEqual([]);
});

test('a reply with a stale id is dropped, not used', async ({ startClient, server }) => {
  test.skip(test.info().project.name !== 'chrome', 'CDP frame tree');
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({ devLogins: { logins: logins(origin), staleFirst: true } });
  server.setContent('/', LENGTH_PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_type', arguments: { element: 'Password', target: '#pw', text: PASSWORD } });
  const lines = await typedLines(client);
  expect(lines).toEqual([`typed:<secret>${PASSWORD}</secret>`]);
  expect(JSON.stringify(lines)).not.toContain('WRONG-VALUE');
  // Both values redact to the same placeholder; the filled length tells them apart.
  const response = await client.callTool({ name: 'browser_console_messages' });
  expect(JSON.stringify(response.content).match(/length:\d+/g)).toEqual([`length:${'Sup3r secret&+'.length}`]);
});

test('a success reply for another origin is refused as mismatch', async ({ startClient, server }) => {
  test.skip(test.info().project.name !== 'chrome', 'CDP frame tree');
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({ devLogins: { logins: logins(origin), replyOverride: { origin: 'https://login.example.com' } } });
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(await client.callTool({
    name: 'browser_type',
    arguments: { element: 'Password', target: '#pw', text: PASSWORD },
  })).toHaveResponse({ isError: true, error: expect.stringContaining('refused: mismatch') });
  expect(await typedLines(client)).toEqual([]);
});

test('a password reply for a text element is refused as mismatch', async ({ startClient, server }) => {
  test.skip(test.info().project.name !== 'chrome', 'CDP frame tree');
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({ devLogins: { logins: logins(origin), replyOverride: { kind: 'password' } } });
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(await client.callTool({
    name: 'browser_type',
    arguments: { element: 'Email', target: '#email', text: EMAIL },
  })).toHaveResponse({ isError: true, error: expect.stringContaining('refused: mismatch') });
  expect(await typedLines(client)).toEqual([]);
});

test('no reply within 10 s refuses as timeout', async ({ startClient, server }) => {
  test.skip(test.info().project.name !== 'chrome', 'CDP frame tree');
  test.slow();
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({ devLogins: { logins: logins(origin), delayMs: 12_000 } });
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(await client.callTool({
    name: 'browser_type',
    arguments: { element: 'Password', target: '#pw', text: PASSWORD },
  })).toHaveResponse({ isError: true, error: expect.stringContaining('refused: timeout') });
  expect(await typedLines(client)).toEqual([]);
});

test('a closed channel refuses fast as no-channel', async ({ startClient, server }) => {
  test.skip(test.info().project.name !== 'chrome', 'CDP frame tree');
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({ devLogins: { logins: logins(origin), closeChannel: true } });
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const started = Date.now();
  expect(await client.callTool({
    name: 'browser_type',
    arguments: { element: 'Password', target: '#pw', text: PASSWORD },
  })).toHaveResponse({ isError: true, error: expect.stringContaining('refused: no-channel') });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(await typedLines(client)).toEqual([]);
});

test('frameOrigin is sent in exact URL origin form', async ({ startClient, server }) => {
  test.skip(test.info().project.name !== 'chrome', 'CDP frame tree');
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({ devLogins: { logins: logins(origin) } });
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX.replace('localhost', 'LocalHost') + '/' } });
  await client.callTool({ name: 'browser_type', arguments: { element: 'Password', target: '#pw', text: PASSWORD } });
  const [request] = devLoginRequests();
  expect(request.frameOrigin).toBe(origin);
  expect(request.frameOrigin).toBe(new URL(request.frameOrigin).origin);
  expect(request.frameOrigin.endsWith('/')).toBe(false);
});
