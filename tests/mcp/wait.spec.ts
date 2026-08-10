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

test('browser_wait_for(text)', async ({ client, server }) => {
  server.setContent('/', `
    <script>
      function update() {
        setTimeout(() => {
          document.querySelector('div').textContent = 'Text to appear';
        }, 1000);
      }
    </script>
    <body>
      <button onclick="update()">Click me</button>
      <div>Text to disappear</div>
    </body>
  `, 'text/html');

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`- generic [ref=e3]: Text to disappear`),
  });

  await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'Click me',
      target: 'e2',
    },
  });

  await client.callTool({
    name: 'browser_wait_for',
    arguments: { text: 'Text to appear' },
  });

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    inlineSnapshot: expect.stringContaining(`- generic [ref=e3]: Text to appear`),
  });
});

test('browser_wait_for(textGone)', async ({ client, server }) => {
  server.setContent('/', `
    <script>
      function update() {
        setTimeout(() => {
          document.querySelector('div').textContent = 'Text to appear';
        }, 1000);
      }
    </script>
    <body>
      <button onclick="update()">Click me</button>
      <div>Text to disappear</div>
    </body>
  `, 'text/html');

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`- generic [ref=e3]: Text to disappear`),
  });

  await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'Click me',
      target: 'e2',
    },
  });

  await client.callTool({
    name: 'browser_wait_for',
    arguments: { textGone: 'Text to disappear' },
  });

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    inlineSnapshot: expect.stringContaining(`- generic [ref=e3]: Text to appear`),
  });
});

test('browser_wait_for(time)', async ({ client, server }) => {
  server.setContent('/', `<body><div>Hello World</div></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  expect(await client.callTool({
    name: 'browser_wait_for',
    arguments: { time: 1 },
  })).toHaveResponse({
    code: `await new Promise(f => setTimeout(f, 1 * 1000));`,
  });
});

test('browser_wait_for(text) ignores a hidden match', async ({ client, server }) => {
  // The hidden copy is the FIRST match in document order. Latching onto it and
  // waiting for it to become visible is the T3 benchmark bug: the wait times
  // out even though the text the caller meant did appear.
  server.setContent('/', `
    <body>
      <div style="display: none">Loaded</div>
      <div id="late"></div>
      <script>
        setTimeout(() => {
          document.querySelector('#late').textContent = 'Loaded';
        }, 500);
      </script>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  expect(await client.callTool({
    name: 'browser_wait_for',
    arguments: { text: 'Loaded' },
  })).toHaveResponse({
    result: `Waited for text "Loaded"`,
  });
});

test('browser_wait_for(textGone) ignores a hidden match', async ({ client, server }) => {
  // Mirror of the above: a hidden copy is already "gone" as far as
  // waitFor({ state: 'hidden' }) is concerned, so latching onto it returns
  // immediately while the copy the caller can actually see is still up.
  server.setContent('/', `
    <body>
      <div style="display: none">Spinner</div>
      <div id="live">Spinner</div>
      <script>
        setTimeout(() => {
          document.querySelector('#live').textContent = 'Done';
        }, 1000);
      </script>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_wait_for',
    arguments: { textGone: 'Spinner' },
  });

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    inlineSnapshot: expect.stringContaining(`Done`),
  });
});

test('browser_wait_for(timeout) gives up early', async ({ client, server }) => {
  server.setContent('/', `<body><div>Hello World</div></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const started = Date.now();
  const response = await client.callTool({
    name: 'browser_wait_for',
    arguments: { text: 'Never appears', timeout: 1 },
  });
  const elapsed = Date.now() - started;

  expect(response).toHaveResponse({ isError: true });
  // The point of the parameter: without it this is pinned to the 5s action
  // timeout regardless of what the caller knows about the page.
  expect(elapsed).toBeLessThan(4000);
});

test('browser_wait_for(timeout) waits past the default action timeout', async ({ client, server }) => {
  server.setContent('/', `
    <body>
      <div id="late"></div>
      <script>
        setTimeout(() => {
          document.querySelector('#late').textContent = 'Finally';
        }, 7000);
      </script>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  expect(await client.callTool({
    name: 'browser_wait_for',
    arguments: { text: 'Finally', timeout: 20 },
  })).toHaveResponse({
    result: `Waited for text "Finally"`,
  });
});

test('browser_wait_for(url) as a substring', async ({ client, server }) => {
  server.setContent('/', `<body><div>Start</div></body>`, 'text/html');
  server.setContent('/checkout/step-2', `<body><div>Checkout</div></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `() => { setTimeout(() => { window.location.href = '/checkout/step-2'; }, 500); }`,
    },
  });

  expect(await client.callTool({
    name: 'browser_wait_for',
    arguments: { url: '/checkout/step-2' },
  })).toHaveResponse({
    result: `Waited for URL matching "/checkout/step-2"`,
  });
});

test('browser_wait_for(url) as a glob', async ({ client, server }) => {
  server.setContent('/', `<body><div>Start</div></body>`, 'text/html');
  server.setContent('/checkout/step-2', `<body><div>Checkout</div></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `() => { setTimeout(() => { window.location.href = '/checkout/step-2'; }, 500); }`,
    },
  });

  expect(await client.callTool({
    name: 'browser_wait_for',
    arguments: { url: '**/checkout/**' },
  })).toHaveResponse({
    result: `Waited for URL matching "**/checkout/**"`,
  });
});

test('browser_wait_for(fn)', async ({ client, server }) => {
  server.setContent('/', `
    <body>
      <script>
        setTimeout(() => { window.__ready = true; }, 500);
      </script>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  expect(await client.callTool({
    name: 'browser_wait_for',
    arguments: { fn: `() => window.__ready === true` },
  })).toHaveResponse({
    result: `Waited for function to return a truthy value`,
  });
});

test('browser_wait_for(fn) reports a timeout rather than hanging', async ({ client, server }) => {
  server.setContent('/', `<body><div>Hello World</div></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  expect(await client.callTool({
    name: 'browser_wait_for',
    arguments: { fn: `() => window.__never === true`, timeout: 1 },
  })).toHaveResponse({ isError: true });
});

test('browser_wait_for(fn) refuses an async predicate', async ({ client, server }) => {
  server.setContent('/', `<body><div>Hello World</div></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  // A promise is truthy on the first poll, so this would otherwise report
  // success immediately while the condition is false.
  const response = await client.callTool({
    name: 'browser_wait_for',
    arguments: { fn: `async () => window.__never === true`, timeout: 1 },
  });

  expect(response).toHaveResponse({ isError: true });
  expect(response.content[0].text).toContain('synchronous predicate');
});

test('browser_wait_for(load)', async ({ client, server }) => {
  server.setContent('/', `<body><div>Hello World</div></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  expect(await client.callTool({
    name: 'browser_wait_for',
    arguments: { load: 'domcontentloaded' },
  })).toHaveResponse({
    result: `Waited for load state "domcontentloaded"`,
  });
});

test('browser_wait_for() with no predicate names the options', async ({ client, server }) => {
  server.setContent('/', `<body><div>Hello World</div></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const response = await client.callTool({
    name: 'browser_wait_for',
    arguments: {},
  });

  expect(response).toHaveResponse({ isError: true });
  expect(response.content[0].text).toContain('time, text, textGone, url, fn or load');
});
