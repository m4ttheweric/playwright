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

import fs from 'fs';
import path from 'path';
import { test, expect } from './fixtures';

test('should respect --snapshot-mode=full', async ({ startClient, server }) => {
  server.setContent('/', `<button>Button 1</button>`, 'text/html');

  const { client } = await startClient({
    args: ['--snapshot-mode=full'],
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: server.PREFIX,
    },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`- button "Button 1" [ref=e2]`),
  });

  await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `async () => {
        const button2 = document.createElement('button');
        button2.textContent = 'Button 2';
        document.body.appendChild(button2);
      }`,
    },
  });

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    inlineSnapshot: expect.stringContaining(`- button "Button 1" [ref=e2]
  - button "Button 2" [ref=e3]`),
  });
});

test('should respect --snapshot-mode=none', async ({ startClient, server }) => {
  server.setContent('/', `<button>Button 1</button>`, 'text/html');

  const { client } = await startClient({
    args: ['--snapshot-mode=none'],
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: server.PREFIX,
    },
  })).toHaveResponse({
    page: `- Page URL: ${server.PREFIX}/`,
  });
});

test('should not inline console messages with --snapshot-mode=none', async ({ startClient, server }) => {
  server.setContent('/', `
    <title>Tab one</title>
    <body>
      <button>Click me</button>
      <script>
        console.log('info message');
        console.error('error message');
      </script>
    </body>
  `, 'text/html');

  const { client } = await startClient({
    args: ['--snapshot-mode=none'],
  });

  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  expect(response).not.toHaveResponse({
    events: expect.stringContaining('error message'),
  });
});

test('should respect snapshot[filename]', async ({ client, server }, testInfo) => {
  // No explicit outputDir is configured, so the default output directory is
  // `<cwd>/.playwright-mcp`, a *subdirectory* of the process cwd used to
  // launch this test's MCP server. A relative filename must land inside
  // that output directory, never directly in cwd (the reported bug).
  server.setContent('/', `<button>Button 1</button>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: server.PREFIX,
    },
  });

  const expectedPath = testInfo.outputPath('.playwright-mcp', 'snapshot1.yml');

  expect(await client.callTool({
    name: 'browser_snapshot',
    arguments: {
      filename: 'snapshot1.yml',
    },
  })).toHaveTextResponse(expect.stringContaining(expectedPath));

  expect(fs.existsSync(testInfo.outputPath('snapshot1.yml'))).toBe(false);
  expect(await fs.promises.readFile(expectedPath, 'utf8')).toContain(`- button "Button 1" [ref=e2]`);
});

test('browser_snapshot filename stays inside output dir, never process cwd', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('session-output');
  const { client } = await startClient({
    config: { outputDir },
  });
  server.setContent('/', `<button>Button 1</button>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const result = await client.callTool({
    name: 'browser_snapshot',
    arguments: { filename: 'page-snapshot.yml' },
  });

  const expectedPath = path.join(outputDir, 'page-snapshot.yml');
  expect(result.content[0].text).toContain(expectedPath);
  expect(await fs.promises.readFile(expectedPath, 'utf8')).toContain(`- button "Button 1" [ref=e2]`);

  // Nothing landed in the process cwd (a sibling of, not inside, outputDir).
  expect(fs.existsSync(testInfo.outputPath('page-snapshot.yml'))).toBe(false);
});

test('browser_snapshot absolute filename keeps working', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ config: { outputDir } });
  server.setContent('/', `<button>Button 1</button>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const absoluteTarget = testInfo.outputPath('explicit-abs-output', 'snap.yml');

  const result = await client.callTool({
    name: 'browser_snapshot',
    arguments: { filename: absoluteTarget },
  });

  expect(result.content[0].text).toContain(absoluteTarget);
  expect(await fs.promises.readFile(absoluteTarget, 'utf8')).toContain(`- button "Button 1" [ref=e2]`);
});

test('browser_snapshot relative traversal is rejected, nothing written', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ config: { outputDir } });
  server.setContent('/', `<button>Button 1</button>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const result = await client.callTool({
    name: 'browser_snapshot',
    arguments: { filename: '../escape.yml' },
  });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('escapes the output directory');
  expect(fs.existsSync(path.join(path.dirname(outputDir), 'escape.yml'))).toBe(false);
  expect(fs.existsSync(testInfo.outputPath('escape.yml'))).toBe(false);
});

test('browser_snapshot(interactiveOnly) keeps the controls and drops the prose', async ({ client, server }) => {
  server.setContent('/', `
    <body>
      <nav aria-label="Main"><ul><li><a href="/docs">Docs</a></li></ul></nav>
      <main>
        <h1>Welcome</h1>
        <p>A paragraph of page text that no agent can click on.</p>
        <button>Search</button>
      </main>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const full = await client.callTool({ name: 'browser_snapshot' });
  const compact = await client.callTool({
    name: 'browser_snapshot',
    arguments: { interactiveOnly: true },
  });

  expect(compact).toHaveResponse({
    inlineSnapshot: expect.stringContaining(`- button "Search" [ref=`),
  });
  expect(compact.content[0].text).toContain('- link "Docs" [ref=');
  expect(compact.content[0].text).toContain('- heading "Welcome"');
  expect(compact.content[0].text).not.toContain('A paragraph of page text');
  expect(compact.content[0].text).toContain('non-interactive nodes omitted');
  expect(compact.content[0].text.length).toBeLessThan(full.content[0].text.length);
});

test('should respect --snapshot-mode=interactive on an implicit snapshot', async ({ startClient, server }) => {
  server.setContent('/', `
    <body>
      <p>A paragraph of page text that no agent can click on.</p>
      <button>Button 1</button>
    </body>
  `, 'text/html');

  const { client } = await startClient({
    args: ['--snapshot-mode=interactive'],
  });

  // The implicit snapshot that rides along with navigate is the one a harness
  // actually pays for on every turn, so the mode has to reach it too.
  const response = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  expect(response).toHaveResponse({
    snapshot: expect.stringContaining(`- button "Button 1" [ref=`),
  });
  expect(response).toHaveResponse({
    snapshot: expect.not.stringContaining(`A paragraph of page text`),
  });
});

test('a ref taken from an interactiveOnly snapshot still resolves', async ({ client, server }) => {
  server.setContent('/', `
    <body>
      <div><div><div>
        <p>Wrappers and prose the compact snapshot throws away.</p>
        <button onclick="document.title = 'Clicked'">Press me</button>
      </div></div></div>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const compact = await client.callTool({
    name: 'browser_snapshot',
    arguments: { interactiveOnly: true },
  });

  // Compact mode re-indents what survives, so the one thing that must not be
  // rewritten along the way is the ref. If it were, the mode would be a trap:
  // smaller, and unusable for the clicking it exists to support.
  const ref = /- button "Press me" \[ref=([^\]]+)\]/.exec(compact.content[0].text)?.[1];
  expect(ref).toBeTruthy();

  expect(await client.callTool({
    name: 'browser_click',
    arguments: { element: 'Press me', target: ref },
  })).toHaveResponse({
    page: expect.stringContaining('- Page Title: Clicked'),
  });
});
