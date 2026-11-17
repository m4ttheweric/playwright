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

const PASSWORD = 'devlogin:login.example.com:password';
const INPUT = `<input id="pw" type="password" aria-label="pw" oninput="console.log('typed:' + this.value)">`;
const tiles = Array.from({ length: 1200 }, (_, i) => `<span style="display: inline-block; width: 20px; height: 20px; background: hsl(${(i * 47) % 360}, 90%, ${30 + (i * 13) % 40}%)"></span>`).join('');

function writeVideoConfig(file: string, video: { width: number, height: number } | null) {
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, trace: true, video }));
}

function webmFiles(dir: string): string[] {
  if (!fs.existsSync(dir))
    return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.webm')).map(f => path.join(dir, f));
}

test('a video turned on in --video-config records from the next call, with no restart', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const configFile = testInfo.outputPath('config.json');
  writeVideoConfig(configFile, null);
  const { client } = await startClient({ args: [`--output-dir=${outputDir}`, `--video-config=${configFile}`] });
  server.setContent('/', `<title>Video</title><body style="margin: 0">${tiles}</body>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect(webmFiles(path.join(outputDir, 'videos'))).toEqual([]);

  writeVideoConfig(configFile, { width: 800, height: 600 });
  expect((await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } })).isError).toBeFalsy();
  await client.callTool({ name: 'browser_wait_for', arguments: { time: 1 } });

  writeVideoConfig(configFile, null);
  expect((await client.callTool({ name: 'browser_snapshot', arguments: {} })).isError).toBeFalsy();

  const videosDir = path.join(outputDir, 'videos');
  await expect.poll(() => webmFiles(videosDir).length, { timeout: 15000 }).toBe(1);
  const [video] = webmFiles(videosDir);
  await expect.poll(() => fs.statSync(video).size, { timeout: 15000 }).toBeGreaterThan(2048);
});

test('a tab opened while --video-config has video on is recorded too', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const configFile = testInfo.outputPath('config.json');
  writeVideoConfig(configFile, { width: 800, height: 600 });
  const { client } = await startClient({ args: [`--output-dir=${outputDir}`, `--video-config=${configFile}`] });
  server.setContent('/', `<title>Video</title><body style="margin: 0">${tiles}</body>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_tabs', arguments: { action: 'new' } });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_wait_for', arguments: { time: 1 } });

  writeVideoConfig(configFile, null);
  await client.callTool({ name: 'browser_snapshot', arguments: {} });
  await expect.poll(() => webmFiles(path.join(outputDir, 'videos')).length, { timeout: 15000 }).toBe(2);
});

test('a video turned off in --video-config lets the next saved-login fill through', async ({ startClient, server }, testInfo) => {
  const origin = new URL(server.PREFIX).origin;
  const configFile = testInfo.outputPath('config.json');
  writeVideoConfig(configFile, { width: 800, height: 600 });
  const { client } = await startClient({
    args: [`--output-dir=${testInfo.outputPath('output')}`, `--video-config=${configFile}`],
    devLogins: { logins: [{ name: PASSWORD, origin, kind: 'password', value: 'Sup3r secret&+' }] },
  });
  server.setContent('/', INPUT, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const refused = await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: PASSWORD } });
  expect(refused.isError).toBe(true);
  const refusal = JSON.stringify(refused.content);
  expect(refusal).toContain('refused: recording');
  expect(refusal).toContain(`video is on: video is set in ${JSON.stringify(configFile).slice(1, -1)}, run fast-browser configure --video off and it stops on the next call`);

  writeVideoConfig(configFile, null);
  const filled = await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: PASSWORD } });
  expect(filled.isError).toBeFalsy();
});

test('video turned on while a filled saved login is on the page waits until the page leaves it', async ({ startClient, server }, testInfo) => {
  const origin = new URL(server.PREFIX).origin;
  const outputDir = testInfo.outputPath('output');
  const videosDir = path.join(outputDir, 'videos');
  const configFile = testInfo.outputPath('config.json');
  writeVideoConfig(configFile, null);
  const { client } = await startClient({
    args: [`--output-dir=${outputDir}`, `--video-config=${configFile}`],
    devLogins: { logins: [{ name: PASSWORD, origin, kind: 'password', value: 'Sup3r secret&+' }] },
  });
  server.setContent('/', INPUT, 'text/html');
  server.setContent('/next', `<title>Next</title><body style="margin: 0">${tiles}</body>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  expect((await client.callTool({ name: 'browser_type', arguments: { element: 'pw', target: '#pw', text: PASSWORD } })).isError).toBeFalsy();

  // On and off again while the value is on the page: a recording that started would be saved on the stop.
  writeVideoConfig(configFile, { width: 800, height: 600 });
  await client.callTool({ name: 'browser_wait_for', arguments: { time: 0.5 } });
  writeVideoConfig(configFile, null);
  await client.callTool({ name: 'browser_wait_for', arguments: { time: 0.1 } });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/next' } });
  await client.callTool({ name: 'browser_wait_for', arguments: { time: 1 } });
  expect(webmFiles(videosDir)).toEqual([]);

  writeVideoConfig(configFile, { width: 800, height: 600 });
  await client.callTool({ name: 'browser_wait_for', arguments: { time: 1 } });
  writeVideoConfig(configFile, null);
  await client.callTool({ name: 'browser_wait_for', arguments: { time: 0.1 } });
  await expect.poll(() => webmFiles(videosDir).length, { timeout: 15000 }).toBe(1);
});

test('a missing --video-config file records nothing and does not fail calls', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ args: [`--output-dir=${outputDir}`, `--video-config=${testInfo.outputPath('absent.json')}`] });
  server.setContent('/', `<title>Video</title>`, 'text/html');
  expect((await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } })).isError).toBeFalsy();
  expect(fs.existsSync(path.join(outputDir, 'videos'))).toBe(false);
});
