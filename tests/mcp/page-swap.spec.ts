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

// FB-74. Under the extension relay a cross-site redirect can make Chrome drop
// the tab's debugger target and hand back a replacement. Playwright sees the
// old page close and a new one open. These tests stand in for that swap over
// --cdp-endpoint, with PWTEST_MCP_TARGET_SWAPS turning on the recovery the
// relay gets: a second client closes the page and opens its replacement,
// which is the same pair of events the relay emits.

import { test, expect } from './fixtures';

import type { BrowserContext } from 'playwright-core';

type StartClient = Parameters<Parameters<typeof test>[2]>[0]['startClient'];

async function startSwapClient(startClient: StartClient, endpoint: string, swaps = true) {
  return await startClient({
    args: [`--cdp-endpoint=${endpoint}`],
    env: swaps ? { PWTEST_MCP_TARGET_SWAPS: '1' } : {},
  });
}

// The page the MCP client drives: every test opens only that page and /other.
function drivenPage(browserContext: BrowserContext) {
  return browserContext.pages().find(page => !page.url().endsWith('/other'))!;
}

async function openPage(browserContext: BrowserContext, url: string) {
  const page = await browserContext.newPage();
  await page.goto(url);
}

async function swapDrivenPage(browserContext: BrowserContext, url: string) {
  await drivenPage(browserContext).close();
  await openPage(browserContext, url);
}

function text(response: any): string {
  return (response.content?.[0] as { text: string } | undefined)?.text ?? '';
}

test.beforeEach(({ server }) => {
  server.setContent('/other', '<title>Other</title>', 'text/html');
  server.setContent('/start', '<title>Start</title>', 'text/html');
  server.setContent('/signin', '<title>Sign in</title><body>Sign in to continue</body>', 'text/html');
  server.setRoute('/hanging', () => {});
});

async function setUp(cdpServer: any, startClient: StartClient, server: any, swaps = true) {
  const browserContext: BrowserContext = await cdpServer.start();
  const { client } = await startSwapClient(startClient, cdpServer.endpoint, swaps);
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/start' } });
  await openPage(browserContext, server.PREFIX + '/other');
  return { browserContext, client };
}

async function tabList(client: any) {
  return text(await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }));
}

// A list call that races the close fails on the closing page and waits up to 6s for a replacement.
async function waitForStartToClose(client: any) {
  await expect.poll(() => tabList(client), { timeout: 20_000 }).not.toContain('[Start]');
}

test('a navigation whose page is swapped mid-call lands on the replacement, not SIDECAR_LOST', async ({ cdpServer, startClient, server }) => {
  const { browserContext, client } = await setUp(cdpServer, startClient, server);

  const navigation = client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/hanging' } });
  await server.waitForRequest('/hanging');
  await swapDrivenPage(browserContext, server.PREFIX + '/signin');
  const response = await navigation;

  expect(text(response)).not.toContain('SIDECAR_LOST');
  expect(response.isError, text(response)).toBeFalsy();
  expect(text(response)).toContain('The page was replaced during the navigation');
  expect(text(response)).toContain(`- Page URL: ${server.PREFIX}/signin`);

  const tabs = await tabList(client);
  expect(tabs).toMatch(/- 0: \(current\) \[Sign in\]/);
  expect(tabs).toMatch(/- 1: \[Other\]/);
});

test('the call after a swap runs on the replacement page', async ({ cdpServer, startClient, server }) => {
  const { browserContext, client } = await setUp(cdpServer, startClient, server);

  await swapDrivenPage(browserContext, server.PREFIX + '/signin');

  const snapshot = text(await client.callTool({ name: 'browser_snapshot', arguments: {} }));
  expect(snapshot).toContain(`- Page URL: ${server.PREFIX}/signin`);
  expect(snapshot).toMatch(/- 0: \(current\) \[Sign in\]/);
  expect(snapshot).toMatch(/- 1: \[Other\]/);
});

test('without the relay a closed tab and a new tab are not paired', async ({ cdpServer, startClient, server }) => {
  const { browserContext, client } = await setUp(cdpServer, startClient, server, false);

  await swapDrivenPage(browserContext, server.PREFIX + '/signin');

  const tabs = await tabList(client);
  expect(tabs).toMatch(/- 0: \(current\) \[Other\]/);
  expect(tabs).toMatch(/- 1: \[Sign in\]/);
});

test('a tab the agent opens after a close is not taken as the replacement', async ({ cdpServer, startClient, server }) => {
  const { browserContext, client } = await setUp(cdpServer, startClient, server);

  await drivenPage(browserContext).close();
  await waitForStartToClose(client);
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'new' } });

  const tabs = await tabList(client);
  expect(tabs).toMatch(/- 0: \[Other\]/);
  expect(tabs).toMatch(/- 1: \(current\) \[/);
});

test('a tab the agent selects after a close stays current when a replacement arrives', async ({ cdpServer, startClient, server }) => {
  const { browserContext, client } = await setUp(cdpServer, startClient, server);

  await drivenPage(browserContext).close();
  await waitForStartToClose(client);
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index: 0 } });
  await openPage(browserContext, server.PREFIX + '/signin');

  const tabs = await tabList(client);
  expect(tabs).toMatch(/\(current\) \[Other\]/);
  expect(tabs).not.toMatch(/\(current\) \[Sign in\]/);
});

test('a call that succeeds while its page closes keeps its result and does not wait', async ({ cdpServer, startClient, server }) => {
  const { client } = await setUp(cdpServer, startClient, server);

  const startedAt = Date.now();
  const response = await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: `async page => { await page.close(); return 'RESULT-42'; }` } });

  expect(Date.now() - startedAt).toBeLessThan(2000);
  expect(response.isError, text(response)).toBeFalsy();
  expect(JSON.stringify(response.content)).toContain('RESULT-42');
});

test('a navigation whose page closes with no replacement keeps its original error', async ({ cdpServer, startClient, server }) => {
  const { browserContext, client } = await setUp(cdpServer, startClient, server);

  const navigation = client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/hanging' } });
  await server.waitForRequest('/hanging');
  await drivenPage(browserContext).close();

  const response = await navigation;
  expect(response.isError).toBe(true);
  expect(text(response)).not.toContain('replaced');
});

test('a browser that dies mid-call reports SIDECAR_LOST without waiting for a replacement', async ({ cdpServer, startClient, server }) => {
  const { browserContext, client } = await setUp(cdpServer, startClient, server);

  const waiting = client.callTool({ name: 'browser_wait_for', arguments: { text: 'never appears' } });
  await new Promise(resolve => setTimeout(resolve, 500));
  const killedAt = Date.now();
  await browserContext.close();

  const response = await waiting;
  expect(Date.now() - killedAt).toBeLessThan(3000);
  expect(text(response)).toContain('SIDECAR_LOST:');
  expect(text(response)).not.toContain('replaced');
});

test('a call that succeeds while its page is swapped keeps its result and says where the page went', async ({ cdpServer, startClient, server }) => {
  const { browserContext, client } = await setUp(cdpServer, startClient, server);

  // The script waits on the other tab, so the swap of its own page cannot fail it.
  const running = client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: `async page => { await page.context().pages().find(p => p.url().endsWith('/other')).waitForTimeout(1500); return 'RESULT-42'; }` } });
  await new Promise(resolve => setTimeout(resolve, 300));
  await swapDrivenPage(browserContext, server.PREFIX + '/signin');
  const response = await running;

  expect(response.isError, text(response)).toBeFalsy();
  expect(JSON.stringify(response.content)).toContain('RESULT-42');
  expect(JSON.stringify(response.content)).toContain(`The page was replaced during this call (a cross-site navigation or redirect). Now on the replacement at ${server.PREFIX}/signin.`);
});
