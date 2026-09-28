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

import { test, expect } from './fixtures';

const NAME = 'devlogin:login.example.com:password';

const PAGE = `<!DOCTYPE html>
  <input id="pw" type="password" oninput="console.log('typed:' + this.value)">`;

async function typedLines(client) {
  const response = await client.callTool({ name: 'browser_console_messages' });
  return JSON.stringify(response.content).match(/typed:(?:(?! @ )[^"\\])*/g) ?? [];
}

test('fill_form refuses a devlogin value with no channel and types nothing', async ({ client, server }) => {
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(await client.callTool({
    name: 'browser_fill_form',
    arguments: { fields: [{ name: 'Password', type: 'textbox', target: '#pw', value: NAME }] },
  })).toHaveResponse({ isError: true, error: expect.stringContaining('refused: no-channel') });
  expect(await typedLines(client)).toEqual([]);
});

test('browser_type refuses a devlogin value with no channel and types nothing', async ({ client, server }) => {
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(await client.callTool({
    name: 'browser_type',
    arguments: { element: 'Password', target: '#pw', text: NAME },
  })).toHaveResponse({ isError: true, error: expect.stringContaining('refused: no-channel') });
  expect(await typedLines(client)).toEqual([]);
});

test('browser_type slowly refuses a devlogin value before any request', async ({ client, server }) => {
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(await client.callTool({
    name: 'browser_type',
    arguments: { element: 'Password', target: '#pw', text: NAME, slowly: true },
  })).toHaveResponse({ isError: true, error: expect.stringContaining('refused: slow-typing') });
  expect(await typedLines(client)).toEqual([]);
});

test('press_sequentially refuses a devlogin value', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--caps=core-input'] });
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_click', arguments: { element: 'Password', target: '#pw' } });
  const response = await client.callTool({ name: 'browser_press_sequentially', arguments: { text: NAME } });
  if (JSON.stringify(response.content).includes('not found'))
    test.skip(true, 'browser_press_sequentially is skill-only and not exposed over MCP');
  expect(response).toHaveResponse({ isError: true, error: expect.stringContaining('refused: slow-typing') });
  expect(await typedLines(client)).toEqual([]);
});

test('a config that defines a devlogin secret is refused at load', async ({ startClient }) => {
  await expect(startClient({ config: { secrets: { [NAME]: 'x' } } })).rejects.toThrow();
});

test('bare-name secrets keep working', async ({ startClient, server }) => {
  const secretsFile = test.info().outputPath('secrets.env');
  await fs.promises.writeFile(secretsFile, 'X-PASSWORD=password123');
  const { client } = await startClient({ args: ['--secrets', secretsFile] });
  server.setContent('/', PAGE, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_type', arguments: { element: 'Password', target: '#pw', text: 'X-PASSWORD' } });
  expect(await typedLines(client)).toEqual(['typed:<secret>X-PASSWORD</secret>']);
});
