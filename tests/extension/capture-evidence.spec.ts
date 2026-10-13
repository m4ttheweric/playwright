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

import { PNG } from '../../packages/playwright-core/lib/utilsBundle';
import { test, expect, connectAndNavigate, startWithExtensionFlag } from './extension-fixtures';

const SHARP = `<!doctype html><html><body style="margin:0;background:#fff;font:14px/1.4 Helvetica,Arial,sans-serif">
  <section data-testid="card" style="margin:24px;padding:16px;width:420px;border:1px solid #ccd;border-radius:8px">
    <h3 style="margin:0 0 8px">Release checklist</h3>
    <p data-testid="line">The quick brown fox jumps over the lazy dog, 0123456789.</p>
    <p style="font-size:11px;color:#555">Small print: reviewers Avery, Blake and Casey signed off.</p>
  </section></body></html>`;

function differing(a: any, b: any) {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i] - b.data[i]) > 16 || Math.abs(a.data[i + 1] - b.data[i + 1]) > 16 || Math.abs(a.data[i + 2] - b.data[i + 2]) > 16)
      ++count;
  }
  return count;
}

function upscaled(image: any) {
  const out = new PNG({ width: image.width * 2, height: image.height * 2 });
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const from = ((y >> 1) * image.width + (x >> 1)) * 4;
      image.data.copy(out.data, (y * out.width + x) * 4, from, from + 4);
    }
  }
  return out;
}

// A capture that hangs must fail this test fast instead of running out the suite timeout.
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no reply in ${ms}ms: the capture hung`)), ms))]);
}

for (const strategy of ['clip', 'override']) {
  test(`a 2x capture through chrome.debugger (${strategy}) is sharp`, async ({ browserWithExtension, startClient, server }, testInfo) => {
    test.setTimeout(90_000);
    server.setContent('/sharp.html', SHARP, 'text/html');
    const url = server.PREFIX + '/sharp.html';
    const browserContext = await browserWithExtension.launch(undefined, ['--force-device-scale-factor=1']);
    const client = await startWithExtensionFlag(browserWithExtension, startClient, {
      PLAYWRIGHT_MCP_CAPTURE_2X: strategy,
      PLAYWRIGHT_MCP_CAPTURE_DIR: testInfo.outputPath('captures'),
    });
    await connectAndNavigate(browserContext, client, url);

    const response = await within(20_000, client.callTool({ name: 'browser_capture_evidence', arguments: { targets: { line: '[data-testid=line]' }, out: 'sharp' } }));
    const text = (response.content as any[]).find(c => c.type === 'text').text as string;
    expect(response.isError, text).toBeFalsy();
    const result = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    expect(result.scale).toBe(2);
    const tool = PNG.sync.read(fs.readFileSync(result.png));

    // The reference comes from the test's own connection to the same tab, so headed rasterisation is compared with itself.
    const tab = browserContext.pages().find(p => p.url() === url)!;
    const cdp = await browserContext.newCDPSession(tab);
    const view = (await cdp.send('Page.getLayoutMetrics')).cssVisualViewport;
    const clip = { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale: 1 };
    const shot = async () => PNG.sync.read(Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false })).data, 'base64'));
    const control = upscaled(await shot());
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 2, mobile: false });
    const reference = await shot();
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    expect([tool.width, tool.height]).toEqual([reference.width, reference.height]);
    const controlDiff = differing(control, reference);
    expect(controlDiff, 'the page has enough text for an upscale to show').toBeGreaterThan(2000);
    expect(differing(tool, reference) * 50).toBeLessThanOrEqual(controlDiff);
  });
}

const SWATCH = `<!doctype html><html><body style="margin:0;background:#fff">
  <section style="margin:24px;padding:16px;width:300px;border:1px solid #ccd">
    <div data-testid="swatch" style="width:40px;height:40px;background:rgb(200,30,60)"></div></section></body></html>`;

// A page with a scrollbar and a window size give the viewport a fractional part of .5 or more.
const TALL = `<!doctype html><html><body style="margin:0;background:#fff"><div style="height:900px"></div>
  <section style="margin:24px;padding:16px;width:300px;height:120px;border:1px solid #ccd"><div data-testid="swatch" style="width:40px;height:40px;background:rgb(200,30,60)"></div></section><div style="height:2400px"></div></body></html>`;

const REAL_SCALES: { scale: number, page: string, window?: number }[] = [
  { scale: 1.5, page: SWATCH }, { scale: 1.25, page: SWATCH }, { scale: 2, page: SWATCH },
  { scale: 1.5, page: TALL, window: 1001 }, { scale: 1.5, page: TALL, window: 1003 },
  { scale: 1.25, page: TALL, window: 1000 }, { scale: 1.25, page: TALL, window: 1003 },
];

for (const { scale, page, window } of REAL_SCALES) {
  test(`a capture at a real device scale of ${scale}${window ? ` in a ${window}px window` : ''} is twice the viewport, with the box on the element`, async ({ browserWithExtension, startClient, server }, testInfo) => {
    test.setTimeout(90_000);
    server.setContent('/swatch.html', page, 'text/html');
    const url = server.PREFIX + '/swatch.html';
    const args = [`--force-device-scale-factor=${scale}`, ...(window ? [`--window-size=${window},${800 + (window - 1000)}`] : [])];
    const browserContext = await browserWithExtension.launch(undefined, args);
    const client = await startWithExtensionFlag(browserWithExtension, startClient, {
      PLAYWRIGHT_MCP_CAPTURE_DIR: testInfo.outputPath('captures'),
    });
    await connectAndNavigate(browserContext, client, url);

    const response = await within(20_000, client.callTool({ name: 'browser_capture_evidence', arguments: { targets: { swatch: '[data-testid=swatch]' }, out: 'scaled' } }));
    const text = (response.content as any[]).find(c => c.type === 'text').text as string;
    expect(response.isError, text).toBeFalsy();
    const result = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    expect(result.scale).toBe(2);

    const tab = browserContext.pages().find(p => p.url() === url)!;
    const cdp = await browserContext.newCDPSession(tab);
    const view = (await cdp.send('Page.getLayoutMetrics')).cssVisualViewport;
    const image = PNG.sync.read(fs.readFileSync(result.png));
    expect(image.width).toBeGreaterThanOrEqual(2 * Math.floor(view.clientWidth));
    expect(image.width).toBeLessThanOrEqual(Math.ceil(2 * view.clientWidth));
    expect(image.height).toBeGreaterThanOrEqual(2 * Math.floor(view.clientHeight));
    expect(image.height).toBeLessThanOrEqual(Math.ceil(2 * view.clientHeight));
    expect(result.frame[0] + result.frame[2]).toBeLessThanOrEqual(image.width / 2);
    expect(result.frame[1] + result.frame[3]).toBeLessThanOrEqual(image.height / 2);

    const [x, y, w, h] = result.boxes.swatch;
    const at = (2 * Math.round(y + h / 2) * image.width + 2 * Math.round(x + w / 2)) * 4;
    expect([image.data[at], image.data[at + 1], image.data[at + 2]]).toEqual([200, 30, 60]);
  });
}
