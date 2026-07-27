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

import fs from 'fs/promises';
import path from 'path';

import { test, testWithOldExtensionVersion, expect, extensionId, clickAllowAndSelect, connectAndNavigate, startWithExtensionFlag } from './extension-fixtures';
import { utils } from '../../packages/playwright-core/lib/coreBundle';

const { defaultUserDataDirForChannel } = utils;

test('accepts a configured extension id', async ({}, testInfo) => {
  const { isPlaywrightExtensionInstalled } = require('../../packages/playwright-core/lib/tools/utils/extension');
  const userDataDir = testInfo.outputPath('profile');
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  await fs.mkdir(path.join(userDataDir, 'Default', 'Extensions', extensionId), { recursive: true });

  expect(await isPlaywrightExtensionInstalled(userDataDir, extensionId)).toBe(true);
  expect(await isPlaywrightExtensionInstalled(
      userDataDir,
      'ponmlkjihgfedcbaponmlkjihgfedcba',
  )).toBe(false);
});

test('Fast Browser extension does not reuse the Microsoft extension id', () => {
  expect(extensionId).not.toBe('mmlmfjhmonkocbjadbfplnigmagldckm');
});

test('Fast Browser extension version reflects the focus-fix content change', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, '../../packages/extension/manifest.json'), 'utf8'));
  const packageJson = JSON.parse(await fs.readFile(path.join(__dirname, '../../packages/extension/package.json'), 'utf8'));

  // The focus fix (2097bb5) changed background.mjs but left manifest.json at
  // 0.2.1, so Chrome reported the same version for two different builds.
  expect(manifest.version).not.toBe('0.2.1');
  expect(manifest.version).toBe(packageJson.version);
  expect(manifest.version).toBe('0.2.2');
});

test(`navigate with extension`, async ({ startExtensionClient, server }) => {
  const { browserContext, client } = await startExtensionClient();

  const confirmationPagePromise = browserContext.waitForEvent('page', page => {
    return page.url().startsWith(`chrome-extension://${extensionId}/connect.html`);
  });

  const navigateResponse = client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  const selectorPage = await confirmationPagePromise;
  await clickAllowAndSelect(selectorPage, 'Welcome');

  expect(await navigateResponse).toHaveResponse({
    snapshot: expect.stringContaining(`- generic [active] [ref=f1e1]: Hello, world!`),
  });
});

test(`connect.html requests protocol version 2`, async ({ startExtensionClient, server }) => {
  const { browserContext, client } = await startExtensionClient();

  const confirmationPagePromise = browserContext.waitForEvent('page', page => {
    return page.url().startsWith(`chrome-extension://${extensionId}/connect.html`);
  });

  client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  }).catch(() => {});

  const selectorPage = await confirmationPagePromise;
  const url = new URL(selectorPage.url());
  expect(url.searchParams.get('protocolVersion')).toBe('2');
});

test(`browser_run_code_unsafe can evaluate in a web worker`, async ({ startExtensionClient, server }) => {
  server.setContent('/worker.js', `
    self.onmessage = (e) => self.postMessage('echo:' + e.data);
    self.workerName = 'mcp-worker';
  `, 'application/javascript');
  server.setContent('/worker-page', `
    <title>WorkerPage</title>
    <body>
      <script>
        window.__worker = new Worker('/worker.js');
      </script>
    </body>
  `, 'text/html');

  const { browserContext, client } = await startExtensionClient();

  const confirmationPagePromise = browserContext.waitForEvent('page', page => {
    return page.url().startsWith(`chrome-extension://${extensionId}/connect.html`);
  });

  const navigateResponse = client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/worker-page' },
  });

  const selectorPage = await confirmationPagePromise;
  await clickAllowAndSelect(selectorPage, 'Welcome');

  await navigateResponse;

  const runCodeResponse = await client.callTool({
    name: 'browser_run_code_unsafe',
    arguments: {
      code: `async (page) => {
        const worker = page.workers().length ? page.workers()[0] : await page.waitForEvent('worker');
        return await worker.evaluate(() => self.workerName);
      }`,
    },
  });

  expect(runCodeResponse).toHaveResponse({
    result: expect.stringContaining('mcp-worker'),
  });

  // Open a second page with its own worker via browser_tabs new and verify
  // that worker eval works in that tab too. This exercises child CDP sessions
  // (the worker session) on a non-first tab — the relay must route them to
  // the correct tab rather than always falling back to the first one.
  server.setContent('/worker2.js', `
    self.workerName = 'mcp-worker-2';
  `, 'application/javascript');
  server.setContent('/worker-page-2', `
    <title>WorkerPage2</title>
    <body>
      <script>
        window.__worker = new Worker('/worker2.js');
      </script>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'new', url: server.PREFIX + '/worker-page-2' },
  });

  const runCodeResponse2 = await client.callTool({
    name: 'browser_run_code_unsafe',
    arguments: {
      code: `async (page) => {
        const worker = page.workers().length ? page.workers()[0] : await page.waitForEvent('worker');
        return await worker.evaluate(() => self.workerName);
      }`,
    },
  });

  expect(runCodeResponse2).toHaveResponse({
    result: expect.stringContaining('mcp-worker-2'),
  });
});

test(`snapshot of an existing page`, async ({ browserWithExtension, startClient, server }) => {
  const browserContext = await browserWithExtension.launch();

  const page = await browserContext.newPage();
  await page.goto(server.HELLO_WORLD);

  // Another empty page.
  await browserContext.newPage();
  expect(browserContext.pages()).toHaveLength(3);

  const client = await startWithExtensionFlag(browserWithExtension, startClient);
  expect(browserContext.pages()).toHaveLength(3);

  const confirmationPagePromise = browserContext.waitForEvent('page', page => {
    return page.url().startsWith(`chrome-extension://${extensionId}/connect.html`);
  });

  const navigateResponse = client.callTool({
    name: 'browser_snapshot',
    arguments: { },
  });

  const selectorPage = await confirmationPagePromise;
  expect(browserContext.pages()).toHaveLength(4);

  await clickAllowAndSelect(selectorPage, 'Title');

  expect(await navigateResponse).toHaveResponse({
    inlineSnapshot: expect.stringContaining(`- generic [active] [ref=e1]: Hello, world!`),
  });
});

testWithOldExtensionVersion(`works with old extension version`, async ({ startExtensionClient, server }) => {
  // Prelaunch the browser, so that it is properly closed after the test.
  const { browserContext, client } = await startExtensionClient();

  const confirmationPagePromise = browserContext.waitForEvent('page', page => {
    return page.url().startsWith(`chrome-extension://${extensionId}/connect.html`);
  });

  const navigateResponse = client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  const selectorPage = await confirmationPagePromise;
  await clickAllowAndSelect(selectorPage, 'Welcome');

  expect(await navigateResponse).toHaveResponse({
    snapshot: expect.stringContaining(`- generic [active] [ref=f1e1]: Hello, world!`),
  });
});

test(`extension needs update`, async ({ startExtensionClient, server }) => {
  // Prelaunch the browser, so that it is properly closed after the test.
  const { browserContext, client } = await startExtensionClient({ PLAYWRIGHT_EXTENSION_PROTOCOL: '1000' });

  const confirmationPagePromise = browserContext.waitForEvent('page', page => {
    return page.url().startsWith(`chrome-extension://${extensionId}/connect.html`);
  });

  // The call hangs as MCP server never connects to the extension.
  client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  }).catch(() => {});

  const confirmationPage = await confirmationPagePromise;
  await expect(confirmationPage.locator('.status-banner')).toContainText(`Fast Browser client trying to connect requires newer extension version`);
});

test(`extension rejects outdated client protocol version`, async ({ startExtensionClient, server }) => {
  const { browserContext, client } = await startExtensionClient({ PLAYWRIGHT_EXTENSION_PROTOCOL: '1' });

  const confirmationPagePromise = browserContext.waitForEvent('page', page => {
    return page.url().startsWith(`chrome-extension://${extensionId}/connect.html`);
  });

  // The call hangs as the extension never connects to the relay.
  client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  }).catch(() => {});

  const confirmationPage = await confirmationPagePromise;
  await expect(confirmationPage.locator('.status-banner')).toContainText(`The client uses an unsupported protocol version. Update Fast Browser MCP or CLI to the latest version.`);
});

test(`custom executablePath skips local extension check`, {
  annotation: { type: 'issue', description: 'https://github.com/microsoft/playwright-mcp/issues/1590' },
}, async ({ startClient, server }) => {
  const executablePath = test.info().outputPath('echo.sh');
  await fs.writeFile(executablePath, '#!/bin/bash\necho "Custom exec args: $@" > "$(dirname "$0")/output.txt"', { mode: 0o755 });

  // Empty profile would normally fail the extension-installed check; it is skipped when executablePath is set.
  const { client } = await startClient({
    args: [`--extension`, `--extension-id=${extensionId}`, `--executable-path=${executablePath}`],
    env: { PWTEST_EXTENSION_USER_DATA_DIR: test.info().outputPath('empty-profile') },
  });

  client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  }).catch(() => {});
  await expect(async () => {
    const output = await fs.readFile(test.info().outputPath('output.txt'), 'utf8');
    expect(output).toMatch(new RegExp(`Custom exec args.*chrome-extension://${extensionId}/connect\\.html\\?`));
  }).toPass();
});

test(`fails when extension is missing in custom userDataDir`, async ({ startClient, server }) => {
  const userDataDir = test.info().outputPath('empty-profile');

  const { client } = await startClient({
    args: [`--extension`, `--extension-id=${extensionId}`],
    env: { PWTEST_EXTENSION_USER_DATA_DIR: userDataDir },
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    error: expect.stringContaining(`Browser extension "${extensionId}" not found in "${userDataDir}". Install the matching extension and run the command again.`),
    isError: true,
  });
});

test(`--browser <channel> selects channel-specific userDataDir`, {
  annotation: { type: 'issue', description: 'https://github.com/microsoft/playwright-mcp/issues/1589' },
}, async ({ startClient, server }) => {
  const expectedUserDataDir = defaultUserDataDirForChannel('chrome-dev')!;

  const { client } = await startClient({
    args: [`--extension`, `--browser=chrome-dev`],
    omitArgs: [`--browser=chromium`],
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    error: expect.stringContaining(
        `Browser extension "mmlmfjhmonkocbjadbfplnigmagldckm" not found in "${expectedUserDataDir}". ` +
        'Install it from https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm'),
    isError: true,
  });
});

test(`browser_cookie_list and browser_cookie_set work in extension mode`, {
  annotation: { type: 'issue', description: 'https://github.com/microsoft/playwright/issues/40687' },
}, async ({ browserWithExtension, startClient, server }) => {
  const browserContext = await browserWithExtension.launch();
  const { client } = await startClient({
    args: [`--extension`, `--extension-id=${extensionId}`],
    config: { capabilities: ['storage'] },
    env: {
      PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
    },
  });

  await connectAndNavigate(browserContext, client, server.HELLO_WORLD);

  // Storage.setCookie / Storage.getCookies are browser-level CDP commands
  // (no sessionId) and used to be rejected outright by the v2 relay.
  await client.callTool({
    name: 'browser_cookie_set',
    arguments: { name: 'extCookie', value: 'extValue' },
  });
  const result = await client.callTool({
    name: 'browser_cookie_list',
    arguments: {},
  });

  expect(result).toHaveResponse({
    result: expect.stringContaining('extCookie=extValue'),
  });
});

test(`bypass connection dialog with token`, async ({ browserWithExtension, startClient, server }) => {
  const browserContext = await browserWithExtension.launch();

  const page = await browserContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/status.html`);
  const token = await page.locator('.auth-token-code').textContent();
  expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  expect(token).not.toContain('PLAYWRIGHT_MCP_EXTENSION_TOKEN=');

  const clientName = 'token-bypass-client';
  const { client } = await startClient({
    clientName,
    args: [`--extension`, `--extension-id=${extensionId}`],
    // The tab group label and status page use the client workspace folder name.
    roots: [{ name: 'workspace', uri: `file:///tmp/pw-bench/${clientName}` }],
    env: {
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: token!,
      PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
    },
  });

  const navigateResponse = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  expect(await navigateResponse).toHaveResponse({
    page: expect.stringContaining('hello-world'),
  });

  await page.goto(`chrome-extension://${extensionId}/status.html`);
  await expect(page.locator('.client-info')).toContainText(`Connected to "${clientName} #1"`);
});
