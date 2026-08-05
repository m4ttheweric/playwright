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

import { test, expect, parseResponse } from './fixtures';

test('no trace dir without --save-trace', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ args: [`--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  expect(fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))).toBeFalsy();
});

test('meta.json reports trace schema 1 and extension protocol 2', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const meta = JSON.parse(fs.readFileSync(path.join(outputDir, traceDir, 'meta.json'), 'utf-8'));
  expect(meta.schemaVersion).toBe(1);
  expect(meta.protocolVersion).toBe(2);
  // IMPORTANT 5: productVersion is threaded from mcp/program.ts's
  // serverVersion (decorateMCPCommand's default is packageJSON.version, the
  // same source runtimeVersion already reads in this default-CLI-entry
  // context) into ContextConfig into TraceLog.create -- it must be present,
  // not just protocolVersion. The Fast Browser product build
  // (fast-browser-mcp/cli.cjs) overrides serverVersion to its own package
  // version, which this test's default entry point (entry/mcp.ts) doesn't
  // exercise, hence asserting presence/type rather than a specific value.
  expect(typeof meta.productVersion).toBe('string');
  expect(meta.productVersion.length).toBeGreaterThan(0);
});

test('a mutating click is recorded with mutating: true', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  server.setContent('/post.html', `<button onclick="fetch('/api/submit', { method: 'POST' })">Go</button>`, 'text/html');
  server.setContent('/api/submit', 'ok', 'text/plain');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/post.html' } });
  const snap = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const ref = /"Go"\s*\[ref=(e\d+)\]/.exec(parseResponse(snap, outputDir)?.inlineSnapshot ?? '')![1];
  await client.callTool({ name: 'browser_click', arguments: { element: 'Go button', target: ref } });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const lines = fs.readFileSync(path.join(outputDir, traceDir, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  expect(lines.find(l => l.tool === 'browser_click').mutating).toBe(true);
});

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
