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

import { test, expect, extensionId, clickAllowAndSelect } from './extension-fixtures';

import type { BrowserContext } from 'playwright';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StartClient } from '../mcp/fixtures';

async function connectExtensionClient(
  clientName: string,
  userDataDir: string,
  startClient: StartClient,
  browserContext: BrowserContext,
  url: string,
): Promise<Client> {
  const { client } = await startClient({
    args: ['--extension', `--extension-id=${extensionId}`],
    clientName,
    // The tab group label is derived from the client workspace folder name.
    roots: [{ name: 'workspace', uri: `file:///tmp/pw-bench/${clientName}` }],
    env: { PWTEST_EXTENSION_USER_DATA_DIR: userDataDir },
  });
  const connectPagePromise = browserContext.waitForEvent('page', page =>
    page.url().startsWith(`chrome-extension://${extensionId}/connect.html`));
  const navigatePromise = client.callTool({ name: 'browser_navigate', arguments: { url } });
  const connectPage = await connectPagePromise;
  await clickAllowAndSelect(connectPage, 'Welcome');
  const response = await navigatePromise;
  expect(response.isError ?? false).toBe(false);
  return client;
}

test('second client does not disconnect the first', async ({ browserWithExtension, startClient, server }) => {
  server.setContent('/a', '<title>PageA</title><body>A</body>', 'text/html');
  server.setContent('/b', '<title>PageB</title><body>B</body>', 'text/html');
  const browserContext = await browserWithExtension.launch();

  const clientA = await connectExtensionClient('AgentA', browserWithExtension.userDataDir, startClient, browserContext, server.PREFIX + '/a');
  await connectExtensionClient('AgentB', browserWithExtension.userDataDir, startClient, browserContext, server.PREFIX + '/b');

  // Single-tenant extension closes A's relay when B connects, failing this call.
  const response = await clientA.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  expect(response.isError ?? false).toBe(false);
  expect(response).toHaveResponse({ page: expect.stringContaining('hello-world') });
});

test('each client gets its own labeled tab group', async ({ browserWithExtension, startClient, server }) => {
  server.setContent('/a', '<title>PageA</title><body>A</body>', 'text/html');
  server.setContent('/b', '<title>PageB</title><body>B</body>', 'text/html');
  const browserContext = await browserWithExtension.launch();

  await connectExtensionClient('AgentA', browserWithExtension.userDataDir, startClient, browserContext, server.PREFIX + '/a');
  await connectExtensionClient('AgentB', browserWithExtension.userDataDir, startClient, browserContext, server.PREFIX + '/b');

  const [sw] = browserContext.serviceWorkers();
  await expect.poll(async () => {
    return sw.evaluate(async () => {
      const chrome = (globalThis as any).chrome;
      const groups = await chrome.tabGroups.query({});
      return groups
          .map((g: any) => ({ title: g.title, color: g.color }))
          .sort((a: any, b: any) => a.title.localeCompare(b.title));
    });
  }).toEqual([
    { title: 'AgentA #1', color: 'green' },
    { title: 'AgentB #2', color: 'blue' },
  ]);
});

test('tabs are isolated per connection', async ({ browserWithExtension, startClient, server }) => {
  server.setContent('/a', '<title>PageA</title><body>A</body>', 'text/html');
  server.setContent('/b', '<title>PageB</title><body>B</body>', 'text/html');
  const browserContext = await browserWithExtension.launch();

  await connectExtensionClient('AgentA', browserWithExtension.userDataDir, startClient, browserContext, server.PREFIX + '/a');
  await connectExtensionClient('AgentB', browserWithExtension.userDataDir, startClient, browserContext, server.PREFIX + '/b');

  const [sw] = browserContext.serviceWorkers();
  await expect.poll(async () => {
    return sw.evaluate(async () => {
      const chrome = (globalThis as any).chrome;
      const groups = await chrome.tabGroups.query({});
      const result: Record<string, string[]> = {};
      for (const group of groups) {
        const tabs = await chrome.tabs.query({ groupId: group.id });
        result[group.title] = tabs.map((t: any) => new URL(t.url).pathname).sort();
      }
      return result;
    });
  }).toEqual({
    'AgentA #1': ['/a'],
    'AgentB #2': ['/b'],
  });
});

test('disconnecting one client keeps the other alive', async ({ browserWithExtension, startClient, server }) => {
  server.setContent('/a', '<title>PageA</title><body>A</body>', 'text/html');
  server.setContent('/b', '<title>PageB</title><body>B</body>', 'text/html');
  const browserContext = await browserWithExtension.launch();

  const clientA = await connectExtensionClient('AgentA', browserWithExtension.userDataDir, startClient, browserContext, server.PREFIX + '/a');
  const clientB = await connectExtensionClient('AgentB', browserWithExtension.userDataDir, startClient, browserContext, server.PREFIX + '/b');

  await clientA.close();

  const [sw] = browserContext.serviceWorkers();
  await expect.poll(async () => {
    return sw.evaluate(async () => {
      const chrome = (globalThis as any).chrome;
      const groups = await chrome.tabGroups.query({});
      return groups.map((g: any) => g.title).sort();
    });
  }).toEqual(['AgentB #2']);

  const response = await clientB.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  expect(response.isError ?? false).toBe(false);
});

// `document.hasFocus()` is not a reliable signal on its own: Chromium reports
// it true for a CDP-debugger-attached page even when that page's tab is not
// chrome's own active tab (verified against this exact harness). The
// authoritative signal for "did this connection steal the user's tab" is
// chrome's own active-tab bookkeeping, queried through the service worker the
// same way the extension itself would.
async function activeTabUrl(browserContext: BrowserContext): Promise<string | undefined> {
  const [sw] = browserContext.serviceWorkers();
  return sw.evaluate(async () => {
    const chrome = (globalThis as any).chrome;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.url;
  });
}

test('token-bypass clients do not steal focus and can reconnect independently', async ({
  browserWithExtension,
  startClient,
  server,
}) => {
  const browserContext = await browserWithExtension.launch();
  const keeper = await browserContext.newPage();
  await keeper.goto(server.PREFIX + '/keeper');
  await keeper.bringToFront();

  const statusPage = await browserContext.newPage();
  await statusPage.goto(`chrome-extension://${extensionId}/status.html`);
  const token = await statusPage.locator('.auth-token-code').textContent();
  await statusPage.close();

  const connect = async (name: string) => {
    const { client } = await startClient({
      args: ['--extension', `--extension-id=${extensionId}`],
      clientName: name,
      roots: [{ name: 'workspace', uri: `file:///tmp/${name}` }],
      env: {
        PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
        PLAYWRIGHT_MCP_EXTENSION_TOKEN: token!,
      },
    });
    await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/' + name } });
    return client;
  };

  const clientA = await connect('claude');
  expect(await activeTabUrl(browserContext)).toContain('/keeper');
  const clientB = await connect('codex');
  expect(await activeTabUrl(browserContext)).toContain('/keeper');
  expect(await keeper.evaluate(() => document.hasFocus())).toBe(true);
  await clientA.close();
  await connect('claude-reconnected');
  expect(await activeTabUrl(browserContext)).toContain('/keeper');
  expect(await keeper.evaluate(() => document.hasFocus())).toBe(true);
  expect((await clientB.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX + '/codex-still-alive' },
  })).isError ?? false).toBe(false);
});

test('token-bypass browser_tabs new does not steal focus', async ({
  browserWithExtension,
  startClient,
  server,
}) => {
  const browserContext = await browserWithExtension.launch();
  const keeper = await browserContext.newPage();
  await keeper.goto(server.PREFIX + '/keeper');
  await keeper.bringToFront();

  const statusPage = await browserContext.newPage();
  await statusPage.goto(`chrome-extension://${extensionId}/status.html`);
  const token = await statusPage.locator('.auth-token-code').textContent();
  await statusPage.close();

  const { client } = await startClient({
    args: ['--extension', `--extension-id=${extensionId}`],
    clientName: 'codex',
    roots: [{ name: 'workspace', uri: 'file:///tmp/codex' }],
    env: {
      PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: token!,
    },
  });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/codex' } });

  // Reclaim the active tab (the initial connect still steals it once; that
  // part of the flow is covered above) so this test isolates the
  // `browser_tabs new` / createTarget path.
  await keeper.bringToFront();
  expect(await activeTabUrl(browserContext)).toContain('/keeper');

  const response = await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'new', url: server.PREFIX + '/background-new-tab' },
  });
  expect(response.isError ?? false).toBe(false);

  expect(await activeTabUrl(browserContext)).toContain('/keeper');
});

test('tab group label uses the client workspace folder name', async ({ browserWithExtension, startClient, server }) => {
  server.setContent('/a', '<title>PageA</title><body>A</body>', 'text/html');
  const browserContext = await browserWithExtension.launch();

  const { client } = await startClient({
    args: ['--extension', `--extension-id=${extensionId}`],
    clientName: 'AgentA',
    roots: [{ name: 'workspace', uri: 'file:///tmp/pw-slug-test/skunk' }],
    env: { PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir },
  });
  const connectPagePromise = browserContext.waitForEvent('page', page =>
    page.url().startsWith(`chrome-extension://${extensionId}/connect.html`));
  const navigatePromise = client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/a' } });
  const connectPage = await connectPagePromise;
  await clickAllowAndSelect(connectPage, 'Welcome');
  const response = await navigatePromise;
  expect(response.isError ?? false).toBe(false);

  const [sw] = browserContext.serviceWorkers();
  await expect.poll(async () => {
    return sw.evaluate(async () => {
      const chrome = (globalThis as any).chrome;
      const groups = await chrome.tabGroups.query({});
      return groups.map((g: any) => g.title);
    });
  }).toEqual(['skunk #1']);
});
