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
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

// High-frequency content so the VP8 keyframe is clearly larger than a
// container stub; smooth gradients compress down to a few kilobytes.
const tiles = Array.from({ length: 1200 }, (_, i) => `<span style="display: inline-block; width: 20px; height: 20px; background: hsl(${(i * 47) % 360}, 90%, ${30 + (i * 13) % 40}%)"></span>`).join('');
const pageContent = `
  <title>Save video</title>
  <body style="margin: 0">${tiles}</body>
`;

for (const mode of ['isolated', 'persistent']) {
  test(`--save-video records a webm into the videos subdirectory (${mode})`, async ({ startClient, server }, testInfo) => {
    const outputDir = testInfo.outputPath('output');
    const { client } = await startClient({
      args: [
        `--output-dir=${outputDir}`,
        '--save-video=800x600',
        ...(mode === 'isolated' ? ['--isolated'] : []),
      ],
    });

    server.setContent('/', pageContent, 'text/html');
    await navigateAndClose(client, server);

    const videosDir = path.join(outputDir, 'videos');
    // The context close that finalizes the recording swallows errors, so poll
    // instead of trusting the close response.
    await expect.poll(() => webmFiles(videosDir).length, { timeout: 15000 }).toBeGreaterThan(0);
    const [video] = webmFiles(videosDir);
    await expect.poll(() => fs.statSync(video).size, { timeout: 15000 }).toBeGreaterThan(2048);

    const magic = Buffer.alloc(4);
    const fd = await fs.promises.open(video, 'r');
    await fd.read(magic, 0, 4, 0);
    await fd.close();
    expect(magic).toEqual(Buffer.from([0x1A, 0x45, 0xDF, 0xA3]));
  });
}

test('no videos directory without --save-video', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({
    args: [`--output-dir=${outputDir}`],
  });

  server.setContent('/', pageContent, 'text/html');
  await navigateAndClose(client, server);

  expect(fs.existsSync(path.join(outputDir, 'videos'))).toBe(false);
});

async function navigateAndClose(client: Client, server: any) {
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    code: expect.stringContaining(`page.goto('http://localhost`),
  });

  expect(await client.callTool({
    name: 'browser_close',
  })).toHaveResponse({
    code: expect.stringContaining(`page.close()`),
  });
}

function webmFiles(dir: string): string[] {
  if (!fs.existsSync(dir))
    return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.webm')).map(f => path.join(dir, f));
}
