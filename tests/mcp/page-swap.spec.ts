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
// --cdp-endpoint: a second client closes the page mid-call and opens its
// replacement, which is the same pair of events the relay emits.

import { test, expect } from './fixtures';

import type { BrowserContext } from 'playwright-core';

// The page the MCP client drives: every test opens only that page and /other.
function drivenPage(browserContext: BrowserContext) {
  return browserContext.pages().find(page => !page.url().endsWith('/other'))!;
}

async function swapDrivenPage(browserContext: BrowserContext, url: string) {
  await drivenPage(browserContext).close();
  const replacement = await browserContext.newPage();
  await replacement.goto(url);
}

async function openOther(browserContext: BrowserContext, server: any) {
  const other = await browserContext.newPage();
  await other.goto(server.PREFIX + '/other');
}

function errorText(response: any): string {
  return (response.content?.[0] as { text: string } | undefined)?.text ?? '';
}

test('a navigation whose page is swapped mid-call lands on the replacement, not SIDECAR_LOST', async ({ cdpServer, startClient, server }) => {
  const browserContext = await cdpServer.start();
  server.setContent('/other', '<title>Other</title>', 'text/html');
  server.setContent('/signin', '<title>Sign in</title><body>Sign in to continue</body>', 'text/html');
  server.setContent('/start', '<title>Start</title>', 'text/html');
  server.setRoute('/redirecting', () => {});
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/start' } });
  await openOther(browserContext, server);

  const navigation = client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/redirecting' } });
  await server.waitForRequest('/redirecting');
  await swapDrivenPage(browserContext, server.PREFIX + '/signin');
  const response = await navigation;

  expect(errorText(response)).not.toContain('SIDECAR_LOST');
  expect(response.isError, errorText(response)).toBeFalsy();
  expect(errorText(response)).toContain('The page was replaced during the navigation');
  expect(errorText(response)).toContain(`- Page URL: ${server.PREFIX}/signin`);

  const tabs = errorText(await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }));
  expect(tabs).toMatch(/- 0: \(current\) \[Sign in\]/);
  expect(tabs).toMatch(/- 1: \[Other\]/);
});

test('the call after a swap runs on the replacement page', async ({ cdpServer, startClient, server }) => {
  const browserContext = await cdpServer.start();
  server.setContent('/other', '<title>Other</title>', 'text/html');
  server.setContent('/start', '<title>Start</title>', 'text/html');
  server.setContent('/signin', '<title>Sign in</title><body>Sign in to continue</body>', 'text/html');
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/start' } });
  await openOther(browserContext, server);

  await swapDrivenPage(browserContext, server.PREFIX + '/signin');

  const snapshot = errorText(await client.callTool({ name: 'browser_snapshot', arguments: {} }));
  expect(snapshot).toContain(`- Page URL: ${server.PREFIX}/signin`);
  expect(snapshot).toMatch(/- 0: \(current\) \[Sign in\]/);
  expect(snapshot).toMatch(/- 1: \[Other\]/);
});

test('a page closed mid-call with no replacement still fails as closed', async ({ cdpServer, startClient, server }) => {
  const browserContext = await cdpServer.start();
  server.setContent('/other', '<title>Other</title>', 'text/html');
  server.setContent('/start', '<title>Start</title>', 'text/html');
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/start' } });
  await openOther(browserContext, server);

  const hanging = client.callTool({ name: 'browser_evaluate', arguments: { function: '() => new Promise(() => {})' } });
  await new Promise(resolve => setTimeout(resolve, 500));
  await drivenPage(browserContext).close();

  const response = await hanging;
  expect(response.isError).toBe(true);
  expect(errorText(response)).toContain('Target page, context or browser has been closed');
  expect(errorText(response)).not.toContain('replaced');
});

test('a browser that dies mid-call fails as closed without waiting for a replacement', async ({ cdpServer, startClient, server }) => {
  const browserContext = await cdpServer.start();
  server.setContent('/start', '<title>Start</title>', 'text/html');
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/start' } });

  const hanging = client.callTool({ name: 'browser_evaluate', arguments: { function: '() => new Promise(() => {})' } });
  await new Promise(resolve => setTimeout(resolve, 500));
  const killedAt = Date.now();
  await browserContext.close();

  const response = await hanging;
  expect(Date.now() - killedAt).toBeLessThan(3000);
  expect(response.isError).toBe(true);
  expect(errorText(response)).toContain('Target page, context or browser has been closed');
  expect(errorText(response)).not.toContain('replaced');
});
