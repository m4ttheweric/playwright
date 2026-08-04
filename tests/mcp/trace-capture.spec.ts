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

test('--save-trace creates trace dir with meta.json and actions.jsonl', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'));
  expect(traceDir).toBeTruthy();
  const meta = JSON.parse(fs.readFileSync(path.join(outputDir, traceDir!, 'meta.json'), 'utf-8'));
  expect(meta.schemaVersion).toBe(1);
  expect(meta.protocolVersion).toBe(2);
  expect(fs.existsSync(path.join(outputDir, traceDir!, 'actions.jsonl'))).toBe(true);
});

test('no trace dir without --save-trace', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ args: [`--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  expect(fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))).toBeFalsy();
});

test('each tool call appends one TraceRecord with tool, params, urls, code', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  server.setContent('/btn.html', `<button onclick="this.textContent='clicked'">Go</button>`, 'text/html');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/btn.html' } });
  await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const lines = fs.readFileSync(path.join(outputDir, traceDir, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  expect(lines.length).toBe(2);
  expect(lines[0]).toMatchObject({ v: 1, seq: 1, tool: 'browser_navigate' });
  expect(lines[0].params).toMatchObject({ url: server.PREFIX + '/btn.html' });
  expect(lines[0].urlAfter).toBe(server.PREFIX + '/btn.html');
  expect(lines[0].endedAt >= lines[0].startedAt).toBe(true);
  expect(lines[1]).toMatchObject({ seq: 2, tool: 'browser_snapshot' });
});

test('tool errors are recorded with error field', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  await client.callTool({ name: 'browser_click', arguments: { element: 'nope', target: 'e999' } });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const lines = fs.readFileSync(path.join(outputDir, traceDir, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  expect(lines[1].tool).toBe('browser_click');
  expect(typeof lines[1].error).toBe('string');
});
