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

test('browser_storage_state unavailable', async ({ startClient, server }) => {
  const { client } = await startClient();
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  expect(await client.callTool({
    name: 'browser_storage_state',
  })).toHaveResponse({
    error: 'Tool "browser_storage_state" not found',
    isError: true,
  });

  expect(await client.callTool({
    name: 'browser_set_storage_state',
  })).toHaveResponse({
    error: 'Tool "browser_set_storage_state" not found',
    isError: true,
  });
});

test('browser_storage_state saves storage state to file', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');

  const { client } = await startClient({
    config: { outputDir, capabilities: ['storage'] },
  });

  // Navigate and set some cookies
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.EMPTY_PAGE },
  });

  await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => { document.cookie = "testCookie=testValue"; localStorage.setItem("testKey", "testValue"); }' },
  });

  // Save storage state
  const result = await client.callTool({
    name: 'browser_storage_state',
    arguments: {},
  });

  // No filename was suggested (auto-generated name), so this keeps the
  // existing workspace-relative link; only caller-supplied filenames report
  // the resolved absolute path (see the "custom filename" test below).
  expect(result).toHaveResponse({
    result: expect.stringMatching(/- \[Storage state\]\(output.storage-state-.*.json/),
    code: expect.stringContaining('page.context().storageState'),
  });

  // Verify the file was created and contains the cookie
  const files = await fs.promises.readdir(outputDir);
  const storageStateFile = files.find(f => f.startsWith('storage-state-'));
  expect(storageStateFile).toBeDefined();

  const content = JSON.parse(await fs.promises.readFile(path.join(outputDir, storageStateFile!), 'utf-8'));
  expect(content.cookies).toContainEqual(expect.objectContaining({
    name: 'testCookie',
    value: 'testValue',
  }));
});

test('browser_storage_state saves to custom filename', async ({ startClient, server }, testInfo) => {
  const { client } = await startClient({
    config: { capabilities: ['storage'] },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.EMPTY_PAGE },
  });

  // No explicit outputDir is configured, so the default output directory is
  // `<cwd>/.playwright-mcp`. The relative filename must land there, never
  // directly in cwd.
  const expectedPath = testInfo.outputPath('.playwright-mcp', 'my-state.json');

  const result = await client.callTool({
    name: 'browser_storage_state',
    arguments: { filename: 'my-state.json' },
  });

  expect(result).toHaveResponse({
    result: expect.stringContaining(expectedPath),
  });

  expect(await fs.promises.stat(testInfo.outputPath('my-state.json')).catch(() => null)).toBeNull();
  expect(await fs.promises.stat(expectedPath).catch(() => null)).not.toBeNull();
});

test('browser_storage_state relative traversal is rejected, nothing written', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({
    config: { outputDir, capabilities: ['storage'] },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.EMPTY_PAGE },
  });

  const result = await client.callTool({
    name: 'browser_storage_state',
    arguments: { filename: '../escape-state.json' },
  });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('escapes the output directory');
  expect(fs.existsSync(path.join(path.dirname(outputDir), 'escape-state.json'))).toBe(false);
  expect(fs.existsSync(testInfo.outputPath('escape-state.json'))).toBe(false);
});

test('browser_set_storage_state restores storage state from file', async ({ startClient, server, mcpBrowser }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  await fs.promises.mkdir(outputDir, { recursive: true });

  // Create a storage state file
  const storageState = {
    cookies: [{
      name: 'restoredCookie',
      value: 'restoredValue',
      domain: 'localhost',
      path: '/',
    }],
    origins: [{
      origin: server.PREFIX,
      localStorage: [{
        name: 'restoredKey',
        value: 'restoredValue',
      }],
    }],
  };

  const stateFile = path.join(outputDir, 'state.json');
  await fs.promises.writeFile(stateFile, JSON.stringify(storageState));

  const { client } = await startClient({
    config: { outputDir, capabilities: ['storage'] },
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.EMPTY_PAGE },
  });

  // Restore storage state
  const result = await client.callTool({
    name: 'browser_set_storage_state',
    arguments: { filename: stateFile },
  });

  expect(result).toHaveResponse({
    result: expect.stringContaining('Storage state restored'),
    code: expect.stringContaining('page.context().setStorageState'),
  });

  // Verify the cookie was restored
  const cookieResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => document.cookie' },
  });

  expect(cookieResult).toHaveResponse({
    result: expect.stringContaining('restoredCookie=restoredValue'),
  });

  // Verify localStorage was restored
  const localStorageResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => localStorage.getItem("restoredKey")' },
  });

  expect(localStorageResult).toHaveResponse({
    result: expect.stringContaining('restoredValue'),
  });
});

test('--storage-state option works with remote endpoint in config', async ({ startClient, server, wsEndpoint }, testInfo) => {
  const stateFile = testInfo.outputPath('state.json');
  const storageState = {
    cookies: [{
      name: 'remoteCookie',
      value: 'remoteValue',
      domain: 'localhost',
      path: '/',
    }],
    origins: [],
  };
  await fs.promises.writeFile(stateFile, JSON.stringify(storageState));

  const { client } = await startClient({
    config: { browser: { remoteEndpoint: wsEndpoint, isolated: true } },
    args: ['--storage-state', stateFile],
  });

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.EMPTY_PAGE },
  });

  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => document.cookie' },
  });

  expect(result).toHaveResponse({
    result: expect.stringContaining('remoteCookie=remoteValue'),
  });
});

test('browser_storage_state and browser_set_storage_state roundtrip', async ({ startClient, server, mcpBrowser }, testInfo) => {
  const { client } = await startClient({
    config: { capabilities: ['storage'] },
  });

  // Navigate and set data
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.EMPTY_PAGE },
  });

  await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => { document.cookie = "roundtripCookie=roundtripValue"; localStorage.setItem("roundtripKey", "roundtripValue"); }' },
  });

  // Save storage state. The result reports the resolved absolute path
  // (inside the output directory, not the process cwd); read it back from
  // there rather than assuming a location.
  const saveResult = await client.callTool({
    name: 'browser_storage_state',
    arguments: { filename: 'roundtrip-state.json' },
  });
  const savedPath = saveResult.content[0].text.match(/\[Storage state\]\(([^)]+)\)/)?.[1];
  expect(savedPath).toBeTruthy();
  expect(path.isAbsolute(savedPath!)).toBe(true);

  // Clear storage
  await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => { document.cookie = "roundtripCookie=; expires=Thu, 01 Jan 1970 00:00:00 GMT"; localStorage.clear(); }' },
  });

  // Verify storage is cleared
  const clearedResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => document.cookie + "|" + localStorage.getItem("roundtripKey")' },
  });

  expect(clearedResult).toHaveResponse({
    result: expect.stringContaining('|null'),
  });

  // Restore storage state
  await client.callTool({
    name: 'browser_set_storage_state',
    arguments: { filename: savedPath! },
  });

  // Reload to pick up cookies
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.EMPTY_PAGE },
  });

  // Verify storage was restored
  const restoredResult = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => document.cookie + "|" + localStorage.getItem("roundtripKey")' },
  });

  expect(restoredResult).toHaveResponse({
    result: expect.stringContaining('roundtripCookie=roundtripValue'),
  });
});
