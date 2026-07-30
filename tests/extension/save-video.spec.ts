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

import { test, expect, extensionId, clickAllowAndSelect } from './extension-fixtures';

// High-frequency content so the VP8 keyframe is clearly larger than a
// container stub; smooth gradients compress down to a few kilobytes.
const tiles = Array.from({ length: 1200 }, (_, i) => `<span style="display: inline-block; width: 20px; height: 20px; background: hsl(${(i * 47) % 360}, 90%, ${30 + (i * 13) % 40}%)"></span>`).join('');
const pageContent = `
  <title>Save video</title>
  <body style="margin: 0">${tiles}</body>
`;

test('--save-video records the relay-attached tab into the videos subdirectory', async ({ browserWithExtension, startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const browserContext = await browserWithExtension.launch();
  const { client } = await startClient({
    args: [
      '--extension',
      `--extension-id=${extensionId}`,
      `--output-dir=${outputDir}`,
      '--save-video=800x600',
    ],
    env: {
      PWTEST_EXTENSION_USER_DATA_DIR: browserWithExtension.userDataDir,
    },
  });

  server.setContent('/', pageContent, 'text/html');

  const confirmationPagePromise = browserContext.waitForEvent('page', page =>
    page.url().startsWith(`chrome-extension://${extensionId}/connect.html`)
  );
  const navigateResponse = client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  const selectorPage = await confirmationPagePromise;
  await clickAllowAndSelect(selectorPage, 'Welcome');
  expect(await navigateResponse).toHaveResponse({
    code: expect.stringContaining(`page.goto('http://localhost`),
  });

  // Recording finalizes when the recorded page goes away; browser_close
  // closes the attached tab while the server stays up to flush the encoder.
  expect(await client.callTool({
    name: 'browser_close',
  })).toHaveResponse({
    code: expect.stringContaining(`page.close()`),
  });

  const videosDir = path.join(outputDir, 'videos');
  await expect.poll(() => webmFiles(videosDir).length, { timeout: 15000 }).toBeGreaterThan(0);
  const [video] = webmFiles(videosDir);
  await expect.poll(() => fs.statSync(video).size, { timeout: 15000 }).toBeGreaterThan(2048);

  const magic = Buffer.alloc(4);
  const fd = await fs.promises.open(video, 'r');
  await fd.read(magic, 0, 4, 0);
  await fd.close();
  expect(magic).toEqual(Buffer.from([0x1A, 0x45, 0xDF, 0xA3]));
});

function webmFiles(dir: string): string[] {
  if (!fs.existsSync(dir))
    return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.webm')).map(f => path.join(dir, f));
}
