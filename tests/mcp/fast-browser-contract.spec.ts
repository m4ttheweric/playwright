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

test('unsafe run code is destructive and snapshot-none remains explicit', async ({
  startClient,
  server,
}) => {
  server.setContent('/', '<button>Ready</button>', 'text/html');
  const { client } = await startClient({
    args: ['--snapshot-mode=none', '--timeout-settle=200'],
  });
  const tools = await client.listTools();
  const unsafe = tools.tools.find(tool => tool.name === 'browser_run_code_unsafe');
  expect(unsafe?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });

  const navigate = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  expect(navigate).not.toHaveResponse({ snapshot: expect.anything() });

  expect(await client.callTool({ name: 'browser_snapshot' })).toHaveResponse({
    inlineSnapshot: expect.stringContaining('button "Ready"'),
  });
});
