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

import { test, expect, savedLoginRequests } from './fixtures';

import type { DevLoginFixture } from './fixtures';

const EMAIL = 'devlogin:app-dev:email';
const PASSWORD = 'devlogin:app-dev:password';
const EMAIL_VALUE = 'dev@example.com';
const PASSWORD_VALUE = 'Sup3r secret&+';

const PAGE = `<!DOCTYPE html>
  <title>Login</title>
  <input id="email" type="text">
  <input id="pw" type="password">
  <button>Sign in</button>`;

function line(origin: string) {
  return `- Saved login for ${origin}: fill with ${EMAIL} / ${PASSWORD}`;
}

function saved(origin: string, extra?: Partial<DevLoginFixture>): DevLoginFixture {
  return {
    logins: [
      { name: EMAIL, origin, kind: 'email', value: EMAIL_VALUE },
      { name: PASSWORD, origin, kind: 'password', value: PASSWORD_VALUE },
    ],
    savedLogins: [{ origin, fields: { email: EMAIL, password: PASSWORD } }],
    ...extra,
  };
}

function textOf(response: any): string {
  return response.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

function sections(response: any): Map<string, string> {
  const result = new Map<string, string>();
  for (const chunk of textOf(response).split(/^### /m).slice(1)) {
    const newline = chunk.indexOf('\n');
    result.set(chunk.slice(0, newline), chunk.slice(newline + 1).trim());
  }
  return result;
}

test('navigate to a saved origin shows the line in the Page block', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({ devLogins: saved(origin) });
  server.setContent('/', PAGE, 'text/html');
  const response = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const page = sections(response).get('Page');
  expect(page).toContain(`- Page URL: ${server.PREFIX}/`);
  expect(page.split('\n')).toContain(line(origin));
  expect(sections(response).has('Saved login')).toBe(false);
  expect(savedLoginRequests().map(r => [r.type, r.origin])).toEqual([['saved-login', origin]]);
});

test('a second action on the unchanged page shows it as its own section', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({ devLogins: saved(origin) });
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const response = await client.callTool({ name: 'browser_click', arguments: { element: 'Sign in button', target: 'button' } });
  expect(response.isError).toBeFalsy();
  const parsed = sections(response);
  expect(parsed.has('Page')).toBe(false);
  expect(parsed.get('Saved login')).toBe(line(origin));
});

test('an unsaved origin shows no line', async ({ startClient, server }) => {
  const { client } = await startClient({ devLogins: saved('https://login.example.com') });
  server.setContent('/', PAGE, 'text/html');
  const response = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(sections(response).has('Page')).toBe(true);
  expect(textOf(response)).not.toContain('Saved login');
  expect(savedLoginRequests().map(r => r.origin)).toEqual([new URL(server.PREFIX).origin]);
});

test('about:blank shows no line and sends no saved-login request', async ({ startClient, server }) => {
  const { client } = await startClient({ devLogins: saved(new URL(server.PREFIX).origin) });
  for (const url of ['about:blank', 'data:text/html,<title>Data</title><body>data</body>']) {
    const response = await client.callTool({ name: 'browser_navigate', arguments: { url } });
    expect(response.isError).toBeFalsy();
    expect(textOf(response)).not.toContain('Saved login');
  }
  expect(textOf(await client.callTool({ name: 'browser_snapshot', arguments: {} }))).not.toContain('Saved login');
  expect(savedLoginRequests()).toEqual([]);
});

test('a silent origin returns within the bound without the line', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client, stderr } = await startClient({ devLogins: saved(origin, { silentOrigins: [origin] }) });
  server.setContent('/', PAGE, 'text/html');
  // The first call launches the browser, which is not what the bound is about.
  await client.callTool({ name: 'browser_navigate', arguments: { url: 'about:blank' } });
  for (const call of [
    { name: 'browser_navigate', arguments: { url: server.PREFIX } },
    { name: 'browser_click', arguments: { element: 'Sign in button', target: 'button' } },
  ]) {
    const started = Date.now();
    const response = await client.callTool(call);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(response.isError).toBeFalsy();
    expect(textOf(response)).not.toContain('Saved login');
  }
  expect(stderr()).not.toContain('Saved login');
  expect(savedLoginRequests().map(r => r.origin)).toEqual([origin, origin]);
});

for (const [label, fields] of [
  ['values instead of names', { email: EMAIL_VALUE, password: PASSWORD_VALUE }],
  ['an empty name', { email: '', password: PASSWORD }],
  ['swapped names', { email: PASSWORD, password: EMAIL }],
  ['a name with whitespace', { email: 'devlogin:app dev:email', password: PASSWORD }],
  ['a non-string name', { email: 42, password: PASSWORD }],
] as const) {
  test(`a malformed reply (${label}) shows no line`, async ({ startClient, server }) => {
    const origin = new URL(server.PREFIX).origin;
    const { client } = await startClient({ devLogins: saved(origin, { savedLogins: [{ origin, fields: fields as any }] }) });
    server.setContent('/', PAGE, 'text/html');
    const response = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
    expect(response.isError).toBeFalsy();
    expect(sections(response).has('Page')).toBe(true);
    expect(textOf(response)).not.toContain('Saved login');
    expect(textOf(response)).not.toContain(EMAIL_VALUE);
    expect(savedLoginRequests().map(r => r.origin)).toEqual([origin]);
  });
}

test('two tabs: the line follows the current tab', async ({ startClient, server }) => {
  const origin = new URL(server.PREFIX).origin;
  const { client } = await startClient({ devLogins: saved(origin) });
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const other = await client.callTool({ name: 'browser_tabs', arguments: { action: 'new', url: server.CROSS_PROCESS_PREFIX + '/' } });
  expect(sections(other).get('Result')).toContain(`(current) [Login](${server.CROSS_PROCESS_PREFIX}/)`);
  expect(textOf(other)).not.toContain('Saved login');

  const back = await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: 0 } });
  expect(sections(back).get('Result')).toContain(`(current) [Login](${server.PREFIX}/)`);
  expect(sections(back).get('Saved login')).toBe(line(origin));

  const again = await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: 1 } });
  expect(textOf(again)).not.toContain('Saved login');
  expect(savedLoginRequests().map(r => r.origin)).toEqual([origin, new URL(server.CROSS_PROCESS_PREFIX).origin, origin, new URL(server.CROSS_PROCESS_PREFIX).origin]);
});

test('no secrets channel: no line, no error', async ({ startClient, server }) => {
  const { client } = await startClient();
  server.setContent('/', PAGE, 'text/html');
  const navigate = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(navigate.isError).toBeFalsy();
  expect(sections(navigate).has('Page')).toBe(true);
  const click = await client.callTool({ name: 'browser_click', arguments: { element: 'Sign in button', target: 'button' } });
  expect(click.isError).toBeFalsy();
  expect(textOf(navigate) + textOf(click)).not.toContain('Saved login');
});

test('no value or email appears in any result', async ({ startClient, server }) => {
  test.skip(test.info().project.name !== 'chrome', 'CDP frame tree');
  const origin = new URL(server.PREFIX).origin;
  const { client, stderr } = await startClient({ devLogins: saved(origin) });
  server.setContent('/', PAGE, 'text/html');
  const texts: string[] = [];
  texts.push(textOf(await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } })));
  texts.push(textOf(await client.callTool({
    name: 'browser_fill_form',
    arguments: { fields: [
      { name: 'Email', type: 'textbox', target: '#email', value: EMAIL },
      { name: 'Password', type: 'textbox', target: '#pw', value: PASSWORD },
    ] },
  })));
  texts.push(textOf(await client.callTool({ name: 'browser_click', arguments: { element: 'Sign in button', target: 'button' } })));
  texts.push(textOf(await client.callTool({ name: 'browser_snapshot', arguments: {} })));
  const all = texts.join('\n');
  expect(all).toContain(line(origin));
  for (const secret of [EMAIL_VALUE, PASSWORD_VALUE, 'Sup3r']) {
    expect(all).not.toContain(secret);
    expect(stderr()).not.toContain(secret);
  }
});
