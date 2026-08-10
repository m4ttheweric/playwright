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

import type { BrowserContext, Page } from 'playwright';

const connectPagePrefix = `chrome-extension://${extensionId}/connect.html`;

function connectPages(browserContext: BrowserContext): Page[] {
  return browserContext.pages().filter(page => page.url().startsWith(connectPagePrefix));
}

async function readAuthToken(browserContext: BrowserContext): Promise<string> {
  const statusPage = await browserContext.newPage();
  await statusPage.goto(`chrome-extension://${extensionId}/status.html`);
  const token = await statusPage.locator('.auth-token-code').textContent();
  await statusPage.close();
  return token!;
}

test('an unapproved connect page is closed once its client dies', async ({ browserWithExtension, startClient, server }) => {
  // The sweep rides the connect page's ~20s keepalive tick, so this one waits
  // out a real interval rather than a fast path.
  test.setTimeout(120_000);
  const browserContext = await browserWithExtension.launch();

  const { client } = await startClient({
    args: ['--extension', `--extension-id=${extensionId}`],
    clientName: 'abandoned',
    env: { PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir },
  });
  const connectPagePromise = browserContext.waitForEvent('page', page => page.url().startsWith(connectPagePrefix));
  // Never approved: the call hangs until the client goes away.
  void client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } }).catch(() => {});
  await connectPagePromise;
  expect(connectPages(browserContext)).toHaveLength(1);

  await client.close();

  // The connect page holds no socket to the client, so the extension learns of
  // the death by probing the relay on its keepalive tick.
  await expect.poll(() => connectPages(browserContext).length, { timeout: 60_000 }).toBe(0);
});

test('a new session sweeps the connect page a dead session left behind', async ({ browserWithExtension, startClient, server }) => {
  const browserContext = await browserWithExtension.launch();

  const { client: dead } = await startClient({
    args: ['--extension', `--extension-id=${extensionId}`],
    clientName: 'dead',
    env: { PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir },
  });
  const orphanPromise = browserContext.waitForEvent('page', page => page.url().startsWith(connectPagePrefix));
  void dead.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } }).catch(() => {});
  const orphan = await orphanPromise;
  await dead.close();

  // A second session starting up must collect the orphan, well before the
  // 20s keepalive tick would have got to it.
  const { client: live } = await startClient({
    args: ['--extension', `--extension-id=${extensionId}`],
    clientName: 'live',
    env: {
      PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: await readAuthToken(browserContext),
    },
  });
  const response = await live.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  expect(response.isError ?? false).toBe(false);

  await expect.poll(() => orphan.isClosed(), { timeout: 15_000 }).toBe(true);
});

test('a connect page still waiting on a live client is left alone', async ({ browserWithExtension, startClient, server }) => {
  const browserContext = await browserWithExtension.launch();
  server.setContent('/a', '<title>PageA</title><body>A</body>', 'text/html');

  const { client: waiting } = await startClient({
    args: ['--extension', `--extension-id=${extensionId}`],
    clientName: 'waiting',
    env: { PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir },
  });
  const waitingPagePromise = browserContext.waitForEvent('page', page => page.url().startsWith(connectPagePrefix));
  const waitingNavigate = waiting.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/a' } });
  const waitingPage = await waitingPagePromise;

  // A second session sweeps while the first is still pending approval.
  const { client: other } = await startClient({
    args: ['--extension', `--extension-id=${extensionId}`],
    clientName: 'other',
    env: {
      PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: await readAuthToken(browserContext),
    },
  });
  await other.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });

  // Still approvable: the sweep proved the client alive and kept the page.
  expect(waitingPage.isClosed()).toBe(false);
  await clickAllowAndSelect(waitingPage, 'Welcome');
  expect((await waitingNavigate).isError ?? false).toBe(false);
});

test('the connect page goes away with the session that raised it', async ({ browserWithExtension, startClient, server }) => {
  const browserContext = await browserWithExtension.launch();
  const keeper = await browserContext.newPage();
  await keeper.goto(server.PREFIX + '/keeper');

  const { client } = await startClient({
    args: ['--extension', `--extension-id=${extensionId}`],
    clientName: 'grouped',
    env: {
      PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: await readAuthToken(browserContext),
    },
  });
  // Opening the first page in a *new* tab leaves the connect page as the
  // connection's other tab, still showing the connect UI when the session ends.
  const response = await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'new', url: server.HELLO_WORLD },
  });
  expect(response.isError ?? false).toBe(false);
  expect(connectPages(browserContext)).toHaveLength(1);

  await client.close();

  await expect.poll(() => connectPages(browserContext).length, { timeout: 30_000 }).toBe(0);
  expect(keeper.isClosed()).toBe(false);
});

test('a connect page the client navigated is never closed as scaffolding', async ({ browserWithExtension, startClient, server }) => {
  const browserContext = await browserWithExtension.launch();
  server.setContent('/real', '<title>Real</title><body>Real content</body>', 'text/html');

  const { client } = await startClient({
    args: ['--extension', `--extension-id=${extensionId}`],
    clientName: 'navigator',
    env: {
      PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: await readAuthToken(browserContext),
    },
  });
  // Token bypass hands the connect page straight over as the working tab.
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/real' } });
  const working = browserContext.pages().find(page => page.url() === server.PREFIX + '/real');
  expect(working).toBeTruthy();

  await client.close();
  await new Promise(f => setTimeout(f, 3000));

  // It holds a page the user can see, so it survives the session.
  expect(working!.isClosed()).toBe(false);
});
