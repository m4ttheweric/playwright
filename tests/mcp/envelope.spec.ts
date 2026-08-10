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

test('the page block is reprinted only when it changes', async ({ client, server }) => {
  server.setContent('/', `
    <title>Steady</title>
    <body>
      <button onclick="window.__clicked = true">Click me</button>
    </body>
  `, 'text/html');

  // Arriving on the page is a change, so the first response carries it.
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    page: `- Page URL: ${server.PREFIX}/\n- Page Title: Steady`,
  });

  // Clicking moves nothing in the header. Reprinting the same URL, title and
  // console tallies on every action is the per-call envelope cost this trims.
  const clicked = await client.callTool({
    name: 'browser_click',
    arguments: { element: 'Click me', target: 'e2' },
  });

  expect(clicked).not.toHaveResponse({ page: expect.any(String) });
  expect(clicked.content[0].text).not.toContain('### Page');
  // The snapshot itself is untouched by the trim.
  expect(clicked).toHaveResponse({ snapshot: expect.stringContaining('Click me') });
});

test('the page block comes back as soon as the header moves', async ({ client, server }) => {
  server.setContent('/', `<title>One</title><body><a href="/two">Go</a></body>`, 'text/html');
  server.setContent('/two', `<title>Two</title><body><div>Second</div></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  expect(await client.callTool({
    name: 'browser_click',
    arguments: { element: 'Go', target: 'e2' },
  })).toHaveResponse({
    page: expect.stringContaining(`- Page Title: Two`),
  });
});

test('a new console error brings the page block back', async ({ client, server }) => {
  server.setContent('/', `
    <title>Steady</title>
    <body>
      <button onclick="console.error('boom')">Break it</button>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  // The console tallies live in the page block, so a first error has to bring
  // the block back or the caller never learns the page started erroring.
  expect(await client.callTool({
    name: 'browser_click',
    arguments: { element: 'Break it', target: 'e2' },
  })).toHaveResponse({
    page: expect.stringContaining(`- Console: 1 errors, 0 warnings`),
  });
});

test('a closed tab is still reported', async ({ client, server }) => {
  server.setContent('/', `<title>One</title><body><button>Click me</button></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  for (let i = 0; i < 2; i++) {
    await client.callTool({
      name: 'browser_tabs',
      arguments: { action: 'new' },
    });
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX },
    });
  }

  // A tab that closes leaves no header behind to report itself, and the tabs
  // that remain may not have moved at all, so an on-change rule driven by the
  // headers alone drops this on the floor. Three tabs go in so that two
  // survive the close and the list is still worth printing.
  const closed = await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'close' },
  });

  expect(closed.content[0].text).toContain('### Open tabs');
});

test('the tab list is not reprinted while the tabs stand still', async ({ client, server }) => {
  server.setContent('/', `<title>One</title><body><button>Click me</button></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  await client.callTool({
    name: 'browser_tabs',
    arguments: { action: 'new' },
  });
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const snapshot = await client.callTool({ name: 'browser_snapshot' });

  // Two tabs are open, but the caller has already been told so twice.
  expect(snapshot.content[0].text).not.toContain('### Open tabs');
});
