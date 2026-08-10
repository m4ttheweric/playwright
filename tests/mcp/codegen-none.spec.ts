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

// With --codegen=none the "Ran Playwright code" section is suppressed. Any tool
// whose entire response WAS that section then answers with a zero-length text
// block, which some MCP clients treat as an error rather than as success. Every
// tool therefore has to say something of its own.

test('browser_press_key answers with something when codegen is off', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--codegen=none'] });
  server.setContent('/', `<title>T</title><body><input id="i"></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  // A non-Enter key attaches no snapshot, so nothing else can carry the answer.
  const response = await client.callTool({
    name: 'browser_press_key',
    arguments: { key: 'End' },
  });

  expect(response.content[0].text).toBe('### Result\nPressed End');
});

test('browser_press_key still answers when codegen is on', async ({ client, server }) => {
  server.setContent('/', `<title>T</title><body><input id="i"></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  expect(await client.callTool({
    name: 'browser_press_key',
    arguments: { key: 'End' },
  })).toHaveResponse({
    result: 'Pressed End',
    code: `// Press End\nawait page.keyboard.press('End');`,
  });
});

test('browser_type answers without echoing what was typed', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--codegen=none'] });
  server.setContent('/', `<title>T</title><body><input id="i"></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const response = await client.callTool({
    name: 'browser_type',
    arguments: { element: 'input', target: 'e2', text: 'hunter2' },
  });

  expect(response.content[0].text.length).toBeGreaterThan(0);
  // The typed value may be a secret. An acknowledgement is not worth putting
  // one into the transcript, so it names the field and not the value.
  expect(response.content[0].text).not.toContain('hunter2');
});

test('no keyboard tool answers with an empty text block', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--codegen=none', '--caps=core,core-input,testing'] });
  server.setContent('/', `<title>T</title><body><input id="i"></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  // browser_keydown, browser_keyup and browser_press_sequentially are
  // skillOnly, so filteredTools() keeps them off the MCP surface entirely and
  // they cannot be exercised from here. They carry the same acknowledgement
  // for the CLI surface, where they are reachable.
  const calls: [string, Record<string, any>][] = [
    ['browser_press_key', { key: 'End' }],
    ['browser_press_key', { key: 'Enter' }],
    ['browser_type', { element: 'input', target: 'e2', text: 'ab' }],
    ['browser_type', { element: 'input', target: 'e2', text: 'ab', slowly: true }],
  ];

  for (const [name, args] of calls) {
    const response = await client.callTool({ name, arguments: args });
    expect(response.content[0].text, `${name} returned an empty result`).not.toBe('');
    expect(response.content[0].text, `${name} is not registered`).not.toContain('not found');
  }
});
