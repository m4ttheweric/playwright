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

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { PNG } from '../../packages/playwright-core/lib/utilsBundle';
import { test, expect, parseResponse } from './fixtures';

const CARD = `<body style="margin:0;font:14px/1.4 Helvetica,Arial,sans-serif;background:#f4f5f7">
  <main style="padding:24px">
    <section data-testid="card" style="width:420px;padding:16px;background:#fff;border:1px solid #ccd;border-radius:8px">
      <h3 data-testid="heading" style="margin:0 0 8px">Release checklist</h3>
      <p data-testid="owner">Owner: Avery Quinn</p>
      <p data-testid="reviewer">Reviewer: Blake Imani</p>
      <span data-testid="badge" style="display:inline-block;width:12px;height:12px;border-radius:6px;background:#2563eb"></span>
    </section>
    <ul><li><button>Edit</button> <span>Alpha</span></li><li data-testid="row-b"><button>Edit</button> <span>Bravo</span></li></ul>
  </main></body>`;

// The digest covers the image, the frame and the boxes, and also the scale unless it is 1.
function digestFor(png: Buffer, sidecar: any, withScale = sidecar.scale !== 1) {
  const covered = withScale ? { frame: sidecar.frame, boxes: sidecar.boxes, scale: sidecar.scale } : { frame: sidecar.frame, boxes: sidecar.boxes };
  return crypto.createHash('sha256').update(png).update(JSON.stringify(covered)).digest('hex');
}

// Every Chromium channel (chrome, msedge, ...) takes the 2x path; only these engines do not.
const isChromium = (browser?: string) => !['firefox', 'webkit'].includes(browser!);

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"></head>${body}</html>`;

async function start(startClient: any, server: any, testInfo: any, html = CARD, extra: { args?: string[], env?: Record<string, string> } = {}) {
  const captureDir = testInfo.outputPath('captures');
  server.setContent('/', page(html), 'text/html');
  const { client } = await startClient({
    args: [`--output-dir=${testInfo.outputPath('output')}`, `--capture-dir=${captureDir}`, '--viewport-size=1000x700', ...(extra.args ?? [])],
    env: extra.env,
  });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const capture = async (args: Record<string, unknown>) => {
    const response = await client.callTool({ name: 'browser_capture_evidence', arguments: args });
    const text = (response.content as any[]).find(c => c.type === 'text').text as string;
    if (response.isError)
      return { isError: true, text };
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  };
  return { client, capture, captureDir };
}

test('auto frame snaps to the card, and the tool writes the png and a sidecar compose accepts', async ({ startClient, server }, testInfo) => {
  const { capture, captureDir } = await start(startClient, server, testInfo);
  const result = await capture({ targets: { owner: '[data-testid=owner]', reviewer: '[data-testid=reviewer]' }, out: 'board.c1' });
  expect(result.failedStep).toBeUndefined();
  expect(result.schemaVersion).toBe('capture-evidence/1');
  expect(result.source).toBe('live');
  expect(result.frameSnap).toBe('card');
  expect(result.image).toBe('board.c1.png');
  expect(result.png).toBe(path.join(captureDir, 'board.c1.png'));
  expect(result.sidecar).toBe(path.join(captureDir, 'board.c1.capture.json'));
  expect(Object.keys(result.boxes).sort()).toEqual(['owner', 'reviewer']);
  expect(result.frame[2]).toBeLessThan(1000);
  expect(result.missed).toEqual([]);
  expect(result.dark).toBe(false);

  const sidecar = JSON.parse(fs.readFileSync(result.sidecar, 'utf8'));
  expect(Object.keys(sidecar).sort()).toEqual(['boxes', 'dark', 'digest', 'frame', 'frameSnap', 'image', 'missed', 'scale', 'schemaVersion', 'source']);
  expect(sidecar.digest).toBe(digestFor(fs.readFileSync(result.png), sidecar));
});

test('a selector that is not valid syntax fails the call, and the next capture still works', async ({ startClient, server }, testInfo) => {
  const { client, capture } = await start(startClient, server, testInfo);
  const bad = await capture({ targets: { owner: '[data-testid=owner]', bad: 'nope=anything' }, out: 'bad' });
  expect(bad.isError).toBe(true);
  expect(bad.text).toContain('nope');
  await expectNoTags(client);
  const ok = await capture({ targets: { owner: '[data-testid=owner]' }, out: 'bad' });
  expect(Object.keys(ok.boxes)).toEqual(['owner']);
});

test('an ambiguous selector and a selector with no match are missed, never guessed', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo);
  const result = await capture({ targets: { edit: 'button', gone: '[data-testid=nothing]', bravo: '[data-testid=row-b] >> text=Bravo' }, out: 'missed' });
  expect(result.missed).toEqual([{ key: 'edit', reason: 'ambiguous', count: 2 }, { key: 'gone', reason: 'no-match' }]);
  expect(Object.keys(result.boxes)).toEqual(['bravo']);
});

test('no selector matching one element fails at resolve and writes nothing', async ({ startClient, server }, testInfo) => {
  const { capture, captureDir } = await start(startClient, server, testInfo);
  const result = await capture({ targets: { edit: 'button' }, out: 'none' });
  expect(result).toEqual({ failedStep: 'resolve', missed: [{ key: 'edit', reason: 'ambiguous', count: 2 }] });
  expect(fs.existsSync(path.join(captureDir, 'none.png'))).toBe(false);
});

test('bad arguments fail at args', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo);
  expect(await capture({ targets: { owner: '[data-testid=owner]' }, out: '../escape' })).toEqual({ failedStep: 'args', error: 'out must be a simple file name' });
  expect(await capture({ targets: {}, out: 'empty' })).toEqual({ failedStep: 'args', error: 'targets is required' });
});

test('a dark surface is reported as dark', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo, `<body style="margin:0;background:#0b0920;color:#fff">
    <section style="margin:24px;padding:16px;width:400px;border:1px solid #445;min-height:80px"><p data-testid="value">Status: shipped</p></section></body>`);
  expect((await capture({ targets: { value: '[data-testid=value]' }, out: 'dark' })).dark).toBe(true);
});

test('a heading-only strip is not a frame: the union is used and reported', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo, `<body style="margin:0">
    <div style="background:#eef;padding:8px 24px"><h2 data-testid="heading" style="margin:0;font-size:22px">Milestones</h2></div>
    <p style="padding:24px">Body text</p></body>`);
  expect((await capture({ targets: { heading: '[data-testid=heading]' }, out: 'strip' })).frameSnap).toBe('union');
});

test('a card under 64px tall is skipped and the next ancestor that qualifies is the frame', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo, `<body style="margin:0">
    <section data-testid="list" style="margin:24px;padding:12px;width:400px;border:1px solid #ccd">
      <div data-testid="row" style="height:46px;border:1px solid #dde;padding:0 8px;display:flex;align-items:center">
        <span data-testid="chip" style="font-size:12px">Blocked</span></div>
      <div style="height:46px;border:1px solid #dde">Second task</div>
    </section></body>`);
  const result = await capture({ targets: { chip: '[data-testid=chip]' }, out: 'compact' });
  expect(result.frameSnap).toBe('card');
  expect(result.frame[3]).toBeGreaterThan(100);
});

test('targets too far apart for one frame capture nothing', async ({ startClient, server }, testInfo) => {
  const { capture, captureDir } = await start(startClient, server, testInfo, `<body style="margin:0">
    <p data-testid="top">Top</p><div style="height:3000px"></div><p data-testid="bottom">Bottom</p></body>`);
  const result = await capture({ targets: { top: '[data-testid=top]', bottom: '[data-testid=bottom]' }, out: 'far' });
  expect(result).toEqual({ failedStep: 'frame', frameSnap: 'too-large', error: 'the targets cannot share one viewport-sized frame' });
  expect(fs.existsSync(path.join(captureDir, 'far.png'))).toBe(false);
});

test('a tiny badge is measured', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo);
  const result = await capture({ targets: { badge: '[data-testid=badge]', heading: '[data-testid=heading]' }, out: 'badge' });
  expect(result.boxes.badge[2]).toBe(12);
  expect(result.boxes.badge[3]).toBe(12);
});

test('a target clipped by the viewport edge is missed as out-of-view', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo, `<body style="margin:0;overflow:hidden">
    <p data-testid="inside" style="margin:24px 24px 24px 300px">Inside</p>
    <p data-testid="clipped" style="position:absolute;top:60px;left:940px;width:100px;margin:0">Clipped</p></body>`);
  const result = await capture({ targets: { inside: '[data-testid=inside]', clipped: '[data-testid=clipped]' }, out: 'clip' });
  expect(result.missed).toEqual([{ key: 'clipped', reason: 'out-of-view' }]);
  expect(Object.keys(result.boxes)).toEqual(['inside']);
});

test('a hidden target is missed as not-visible', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo, `<body><p data-testid="shown">Shown</p><p data-testid="hidden" style="display:none">Hidden</p></body>`);
  const result = await capture({ targets: { shown: '[data-testid=shown]', hidden: '[data-testid=hidden]' }, out: 'hidden' });
  expect(result.missed).toEqual([{ key: 'hidden', reason: 'not-visible' }]);
});

test('a frame selector must match one element, contain every target and fit the viewport', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo, `<body style="margin:0">
    <section data-testid="panel" style="margin:24px;padding:16px;width:300px;border:1px solid #ccd"><p data-testid="in">In</p></section>
    <p data-testid="out" style="margin:24px">Out</p>
    <section data-testid="tall" style="margin:24px;padding:16px;width:300px;height:1200px;border:1px solid #ccd"><p data-testid="deep">Deep</p></section></body>`);
  expect(await capture({ frame: '[data-testid=nothing]', targets: { in: '[data-testid=in]' }, out: 'f1' }))
      .toEqual({ failedStep: 'frame', error: 'the frame selector must match exactly one element' });
  expect(await capture({ frame: '[data-testid=panel]', targets: { in: '[data-testid=in]', out: '[data-testid=out]' }, out: 'f2' }))
      .toEqual({ failedStep: 'frame', error: 'the frame selector does not contain every target' });
  expect(await capture({ frame: '[data-testid=tall]', targets: { deep: '[data-testid=deep]' }, out: 'f3' }))
      .toEqual({ failedStep: 'frame', error: 'the frame selector is larger than the viewport' });
  const ok = await capture({ frame: '[data-testid=panel]', targets: { in: '[data-testid=in]' }, out: 'f4' });
  expect(ok.frameSnap).toBe('selector');
});

test('a failed call leaves no tags behind for the next call on the same page', async ({ startClient, server }, testInfo) => {
  const { client, capture } = await start(startClient, server, testInfo);
  const first = await capture({ frame: '[data-testid=nothing]', targets: { owner: '[data-testid=owner]' }, out: 'tags' });
  expect(first.failedStep).toBe('frame');
  const second = await capture({ targets: { reviewer: '[data-testid=reviewer]' }, out: 'tags' });
  expect(Object.keys(second.boxes)).toEqual(['reviewer']);
  expect(second.frameSnap).not.toBe('selector');
  await expectNoTags(client);
});

test('capturing again with the same out replaces both files with a matching pair', async ({ startClient, server }, testInfo) => {
  const { client, capture } = await start(startClient, server, testInfo);
  const digestOf = (result: any) => {
    const sidecar = JSON.parse(fs.readFileSync(result.sidecar, 'utf8'));
    return { sidecar, expected: digestFor(fs.readFileSync(result.png), sidecar) };
  };
  const first = await capture({ targets: { owner: '[data-testid=owner]' }, out: 'again' });
  const firstPng = fs.readFileSync(first.png);
  const firstDigest = digestOf(first);
  expect(firstDigest.sidecar.digest).toBe(firstDigest.expected);
  await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => { document.querySelector("[data-testid=owner]").textContent = "Owner: Casey Lund and the rest of the release crew"; }' } });
  const second = await capture({ targets: { owner: '[data-testid=owner]' }, out: 'again' });
  expect(second.png).toBe(first.png);
  expect(fs.readFileSync(second.png).equals(firstPng)).toBe(false);
  const secondDigest = digestOf(second);
  expect(secondDigest.sidecar.digest).toBe(secondDigest.expected);
  expect(secondDigest.sidecar.digest).not.toBe(firstDigest.sidecar.digest);
});

test('without --capture-dir the capture lands in the output directory', async ({ startClient, server }, testInfo) => {
  server.setContent('/', page(CARD), 'text/html');
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ args: [`--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_capture_evidence', arguments: { targets: { owner: '[data-testid=owner]' }, out: 'default' } });
  expect(fs.existsSync(path.join(outputDir, 'default.capture.json'))).toBe(true);
});

test('two keys that resolve to the same element both get a box and no tag is left behind', async ({ startClient, server }, testInfo) => {
  const { client, capture } = await start(startClient, server, testInfo);
  const result = await capture({ targets: { byId: '[data-testid=owner]', byText: 'text=Owner: Avery Quinn' }, out: 'shared' });
  expect(result.missed).toEqual([]);
  expect(Object.keys(result.boxes).sort()).toEqual(['byId', 'byText']);
  expect(result.boxes.byId).toEqual(result.boxes.byText);
  await expectNoTags(client);
});

const SHARP = `<body style="margin:0;background:#fff;font:14px/1.4 Helvetica,Arial,sans-serif">
  <section data-testid="card" style="margin:24px;padding:16px;width:420px;border:1px solid #ccd;border-radius:8px">
    <h3 style="margin:0 0 8px">Release checklist</h3>
    <p data-testid="line">The quick brown fox jumps over the lazy dog, 0123456789.</p>
    <p style="font-size:11px;color:#555">Small print: reviewers Avery, Blake and Casey signed off.</p>
  </section></body>`;

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

for (const strategy of ['clip', 'override']) {
  test(`a 2x capture (${strategy}) matches a native DPR 2 render, and an upscaled 1x does not`, async ({ startClient, server, mcpBrowser }, testInfo) => {
    test.skip(!isChromium(mcpBrowser), 'the 2x path is Chromium only');
    const { client, capture } = await start(startClient, server, testInfo, SHARP, { env: { PLAYWRIGHT_MCP_CAPTURE_2X: strategy } });
    const result = await capture({ targets: { line: '[data-testid=line]' }, out: 'sharp' });
    expect(result.scale).toBe(2);
    const tool = PNG.sync.read(fs.readFileSync(result.png));
    expect([tool.width, tool.height]).toEqual([2000, 1400]);

    const onePath = testInfo.outputPath('output', 'one.png');
    await client.callTool({ name: 'browser_take_screenshot', arguments: { filename: 'one.png', scale: 'css' } });
    const control = upscaled(PNG.sync.read(fs.readFileSync(onePath)));

    const { client: native } = await startClient({
      args: ['--isolated', `--output-dir=${testInfo.outputPath('native')}`],
      config: { browser: { contextOptions: { viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 } } },
    });
    await native.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
    await native.callTool({ name: 'browser_take_screenshot', arguments: { filename: 'native.png', scale: 'device' } });
    const reference = PNG.sync.read(fs.readFileSync(testInfo.outputPath('native', 'native.png')));

    const controlDiff = differing(control, reference);
    expect(controlDiff, 'the page has enough text for an upscale to show').toBeGreaterThan(2000);
    expect(differing(tool, reference) * 50).toBeLessThanOrEqual(controlDiff);
  });
}

test('after an override capture the page is back at its own device scale', async ({ startClient, server, mcpBrowser }, testInfo) => {
  test.skip(!isChromium(mcpBrowser), 'the 2x path is Chromium only');
  const { client, capture } = await start(startClient, server, testInfo, SHARP, { env: { PLAYWRIGHT_MCP_CAPTURE_2X: 'override' } });
  await capture({ targets: { line: '[data-testid=line]' }, out: 'restore' });
  const ratio = await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => `dpr=${devicePixelRatio} width=${innerWidth} height=${innerHeight}`' } });
  expect(parseResponse(ratio).result).toContain('dpr=1 width=1000 height=700');
});

test('a fractional device scale still yields exactly twice the viewport', async ({ startClient, server, mcpBrowser }, testInfo) => {
  test.skip(!isChromium(mcpBrowser), 'the 2x path is Chromium only');
  server.setContent('/', page(SHARP), 'text/html');
  const captureDir = testInfo.outputPath('captures');
  const { client } = await startClient({
    args: [`--output-dir=${testInfo.outputPath('output')}`, `--capture-dir=${captureDir}`],
    config: { browser: { contextOptions: { viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1.5 } } },
  });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_capture_evidence', arguments: { targets: { line: '[data-testid=line]' }, out: 'fraction' } });
  const sidecar = JSON.parse(fs.readFileSync(path.join(captureDir, 'fraction.capture.json'), 'utf8'));
  const image = PNG.sync.read(fs.readFileSync(path.join(captureDir, 'fraction.png')));
  expect(sidecar.scale).toBe(2);
  expect([image.width, image.height]).toEqual([2000, 1400]);
});

test('a target below the fold: the reported box lands on the element in the image', async ({ startClient, server, mcpBrowser }, testInfo) => {
  test.skip(!isChromium(mcpBrowser), 'the 2x path is Chromium only');
  const { capture } = await start(startClient, server, testInfo, `<body style="margin:0;background:#fff">
    <div style="height:2400px"></div>
    <section style="margin:24px;padding:16px;width:300px;height:120px;border:1px solid #ccd">
      <div data-testid="swatch" style="width:40px;height:40px;background:rgb(200,30,60)"></div></section>
    <div style="height:2400px"></div></body>`);
  const result = await capture({ targets: { swatch: '[data-testid=swatch]' }, out: 'fold' });
  expect(result.scale).toBe(2);
  const [x, y, w, h] = result.boxes.swatch;
  const image = PNG.sync.read(fs.readFileSync(result.png));
  const at = (2 * Math.round(y + h / 2) * image.width + 2 * Math.round(x + w / 2)) * 4;
  expect([image.data[at], image.data[at + 1], image.data[at + 2]]).toEqual([200, 30, 60]);
});

test('a target below the fold on a smooth-scrolling page: the box still lands on the element', async ({ startClient, server, mcpBrowser }, testInfo) => {
  test.skip(!isChromium(mcpBrowser), 'the 2x path is Chromium only');
  const { capture } = await start(startClient, server, testInfo, `<style>html { scroll-behavior: smooth }</style><body style="margin:0;background:#fff">
    <div style="height:2400px"></div>
    <section style="margin:24px;padding:16px;width:300px;height:120px;border:1px solid #ccd">
      <div data-testid="swatch" style="width:40px;height:40px;background:rgb(200,30,60)"></div></section>
    <div style="height:2400px"></div></body>`);
  const result = await capture({ targets: { swatch: '[data-testid=swatch]' }, out: 'smooth' });
  expect(result.failedStep).toBeUndefined();
  expect(result.missed).toEqual([]);
  const [x, y, w, h] = result.boxes.swatch;
  const image = PNG.sync.read(fs.readFileSync(result.png));
  const at = (2 * Math.round(y + h / 2) * image.width + 2 * Math.round(x + w / 2)) * 4;
  expect([image.data[at], image.data[at + 1], image.data[at + 2]]).toEqual([200, 30, 60]);
});

test('a page that keeps moving its target fails the capture, writes nothing and leaves no tag', async ({ startClient, server }, testInfo) => {
  // A timer can miss the short window between the tool's two readings; moving the target on every reading cannot.
  const { client, capture, captureDir } = await start(startClient, server, testInfo, `<body style="margin:0"><p data-testid="a" style="position:relative;left:0;margin:24px">Moving</p>
    <script>let n = 0; const measure = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () { document.querySelector('[data-testid=a]').style.left = ++n + 'px'; return measure.call(this); };</script></body>`);
  const result = await capture({ targets: { a: '[data-testid=a]' }, out: 'moving' });
  expect(result.isError).toBe(true);
  expect(result.text).toContain('the page moved while it was captured; capture again');
  expect(fs.existsSync(path.join(captureDir, 'moving.png'))).toBe(false);
  expect(fs.existsSync(path.join(captureDir, 'moving.capture.json'))).toBe(false);
  await expectNoTags(client);
});

test('a page that reflows at 2x fails the capture, writes nothing and gets its device scale back', async ({ startClient, server, mcpBrowser }, testInfo) => {
  test.skip(!isChromium(mcpBrowser), 'the 2x path is Chromium only');
  const { client, capture, captureDir } = await start(startClient, server, testInfo, `<style>@media (min-resolution: 2dppx) { [data-testid=card] { margin-left: 200px !important } }</style>${SHARP}`, { env: { PLAYWRIGHT_MCP_CAPTURE_2X: 'override' } });
  const result = await capture({ targets: { line: '[data-testid=line]' }, out: 'reflow' });
  expect(result.isError).toBe(true);
  expect(result.text).toContain('lays out differently at 2x');
  expect(fs.existsSync(path.join(captureDir, 'reflow.png'))).toBe(false);
  expect(fs.existsSync(path.join(captureDir, 'reflow.capture.json'))).toBe(false);
  const ratio = await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => `dpr=${devicePixelRatio}`' } });
  expect(parseResponse(ratio).result).toContain('dpr=1');
});

test('a page whose script moves the target at 2x and leaves it there fails the capture too', async ({ startClient, server, mcpBrowser }, testInfo) => {
  test.skip(!isChromium(mcpBrowser), 'the 2x path is Chromium only');
  const script = `<script>matchMedia('(min-resolution: 2dppx)').addEventListener('change', e => { if (e.matches) document.querySelector('[data-testid=card]').style.marginLeft = '200px'; });</script>`;
  const { client, capture, captureDir } = await start(startClient, server, testInfo, `${SHARP}${script}`, { env: { PLAYWRIGHT_MCP_CAPTURE_2X: 'override' } });
  const result = await capture({ targets: { line: '[data-testid=line]' }, out: 'moved' });
  expect(result.isError).toBe(true);
  expect(result.text).toContain('lays out differently at 2x');
  expect(fs.existsSync(path.join(captureDir, 'moved.png'))).toBe(false);
  expect(fs.existsSync(path.join(captureDir, 'moved.capture.json'))).toBe(false);
  const ratio = await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => `dpr=${devicePixelRatio}`' } });
  expect(parseResponse(ratio).result).toContain('dpr=1');
});

test('a page whose script moves the target when the device scale returns fails the capture too', async ({ startClient, server, mcpBrowser }, testInfo) => {
  test.skip(!isChromium(mcpBrowser), 'the 2x path is Chromium only');
  // A media-query listener fires at the next rendering step, which races the tool's own measurements; this moves the target on the first measurement after 2x ends.
  const script = `<script>let seen2x = false; const measure = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (matchMedia('(min-resolution: 2dppx)').matches)
        seen2x = true;
      else if (seen2x)
        document.querySelector('[data-testid=card]').style.marginLeft = '200px';
      return measure.call(this);
    };</script>`;
  const { client, capture, captureDir } = await start(startClient, server, testInfo, `${SHARP}${script}`, { env: { PLAYWRIGHT_MCP_CAPTURE_2X: 'override' } });
  const result = await capture({ targets: { line: '[data-testid=line]' }, out: 'returned' });
  expect(result.isError).toBe(true);
  expect(result.text).toContain('lays out differently at 2x');
  expect(fs.existsSync(path.join(captureDir, 'returned.png'))).toBe(false);
  expect(fs.existsSync(path.join(captureDir, 'returned.capture.json'))).toBe(false);
  const ratio = await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => `dpr=${devicePixelRatio}`' } });
  expect(parseResponse(ratio).result).toContain('dpr=1');
});

test('a page that stalls mid-capture returns an error within the deadline, not a hang', async ({ startClient, server }, testInfo) => {
  test.setTimeout(30_000);
  const { capture } = await start(startClient, server, testInfo, `<body><p data-testid="a">One</p><p data-testid="b">Two</p>
    <script>new MutationObserver(() => { for (;;) {} }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-ev-key'] });</script></body>`,
  { env: { PLAYWRIGHT_MCP_CAPTURE_TIMEOUT: '1500' } });
  const started = Date.now();
  const result = await capture({ targets: { a: '[data-testid=a]', b: '[data-testid=b]' }, out: 'stall' });
  expect(result.isError).toBe(true);
  expect(result.text).toMatch(/capture timed out after 1500ms at (resolve|frame|measure|screenshot)/);
  expect(Date.now() - started).toBeLessThan(10_000);
});

test('a page that stalls after framing returns an error at the screenshot, not a hang', async ({ startClient, server }, testInfo) => {
  test.setTimeout(30_000);
  const { capture, captureDir } = await start(startClient, server, testInfo, `<body style="margin:0"><div style="height:3000px"></div><p data-testid="a">One</p><div style="height:3000px"></div>
    <script>addEventListener('scroll', () => { for (;;) {} });</script></body>`,
  { env: { PLAYWRIGHT_MCP_CAPTURE_TIMEOUT: '1500' } });
  const started = Date.now();
  const result = await capture({ targets: { a: '[data-testid=a]' }, out: 'stall-late' });
  expect(result.isError).toBe(true);
  expect(result.text).toMatch(/capture timed out after 1500ms at (screenshot|measure)/);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(fs.existsSync(path.join(captureDir, 'stall-late.png'))).toBe(false);
  expect(fs.existsSync(path.join(captureDir, 'stall-late.capture.json'))).toBe(false);
});

const TAGS_ANYWHERE = `() => {
  const count = root => {
    let n = root.querySelectorAll('[data-ev-key],[data-ev-frame]').length;
    for (const e of root.querySelectorAll('*')) {
      if (e.shadowRoot)
        n += count(e.shadowRoot);
      if (e.tagName === 'IFRAME' && e.contentDocument)
        n += count(e.contentDocument);
    }
    return n;
  };
  return count(document);
}`;

async function expectNoTags(client: any) {
  const left = await client.callTool({ name: 'browser_evaluate', arguments: { function: TAGS_ANYWHERE } });
  expect(parseResponse(left).result.trim()).toBe('0');
}

const SHADOW = `<body style="margin:24px"><p data-testid="light">Light</p><div id="host"></div>
  <script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<p data-testid="inner">Inside</p>';</script></body>`;

const FRAMED = `<body style="margin:24px"><p data-testid="light">Light</p>
  <iframe srcdoc="<p data-testid='deep'>Deep</p>" style="width:300px;height:100px"></iframe></body>`;

test('a target inside an open shadow root is refused beside a light target, and no tag is left', async ({ startClient, server }, testInfo) => {
  const { client, capture, captureDir } = await start(startClient, server, testInfo, SHADOW);
  const result = await capture({ targets: { light: '[data-testid=light]', inner: '[data-testid=inner]' }, out: 'shadow' });
  expect(result).toEqual({ failedStep: 'resolve', error: 'a target inside a shadow root or an iframe cannot be captured' });
  expect(fs.existsSync(path.join(captureDir, 'shadow.png'))).toBe(false);
  expect(fs.existsSync(path.join(captureDir, 'shadow.capture.json'))).toBe(false);
  await expectNoTags(client);
});

test('a target that is only inside an open shadow root is refused, and no tag is left', async ({ startClient, server }, testInfo) => {
  const { client, capture, captureDir } = await start(startClient, server, testInfo, SHADOW);
  const result = await capture({ targets: { inner: '[data-testid=inner]' }, out: 'shadow-only' });
  expect(result).toEqual({ failedStep: 'resolve', error: 'a target inside a shadow root or an iframe cannot be captured' });
  expect(fs.existsSync(path.join(captureDir, 'shadow-only.png'))).toBe(false);
  expect(fs.existsSync(path.join(captureDir, 'shadow-only.capture.json'))).toBe(false);
  await expectNoTags(client);
});

test('a target inside an iframe is refused, and no tag is left', async ({ startClient, server }, testInfo) => {
  const { client, capture, captureDir } = await start(startClient, server, testInfo, FRAMED);
  const result = await capture({ targets: { light: '[data-testid=light]', deep: 'iframe >> internal:control=enter-frame >> [data-testid=deep]' }, out: 'framed' });
  expect(result).toEqual({ failedStep: 'resolve', error: 'a target inside a shadow root or an iframe cannot be captured' });
  expect(fs.existsSync(path.join(captureDir, 'framed.png'))).toBe(false);
  expect(fs.existsSync(path.join(captureDir, 'framed.capture.json'))).toBe(false);
  await expectNoTags(client);
});

test('a frame selector inside a shadow root is refused, and no tag is left', async ({ startClient, server }, testInfo) => {
  const { client, capture, captureDir } = await start(startClient, server, testInfo, SHADOW);
  const result = await capture({ frame: '[data-testid=inner]', targets: { light: '[data-testid=light]' }, out: 'shadow-frame' });
  expect(result).toEqual({ failedStep: 'frame', error: 'a frame inside a shadow root or an iframe cannot be captured' });
  expect(fs.existsSync(path.join(captureDir, 'shadow-frame.png'))).toBe(false);
  expect(fs.existsSync(path.join(captureDir, 'shadow-frame.capture.json'))).toBe(false);
  await expectNoTags(client);
});

test('a hidden target does not stretch the frame: the visible one far below is captured and the hidden one is missed', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo, `<body style="margin:0"><p data-testid="hidden" style="display:none">Hidden</p>
    <div style="height:1500px"></div><p data-testid="shown" style="margin:24px">Shown</p><div style="height:1500px"></div></body>`);
  const result = await capture({ targets: { hidden: '[data-testid=hidden]', shown: '[data-testid=shown]' }, out: 'hidden-far' });
  expect(result.failedStep).toBeUndefined();
  expect(Object.keys(result.boxes)).toEqual(['shown']);
  expect(result.missed).toEqual([{ key: 'hidden', reason: 'not-visible' }]);
});

test('a frame selector that holds the visible target is accepted while another target is hidden', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo, `<body style="margin:0">
    <section data-testid="panel" style="margin:24px;padding:16px;width:300px;border:1px solid #ccd"><p data-testid="in">In</p></section>
    <p data-testid="hidden" style="display:none">Hidden</p></body>`);
  const result = await capture({ frame: '[data-testid=panel]', targets: { in: '[data-testid=in]', hidden: '[data-testid=hidden]' }, out: 'hidden-frame' });
  expect(result.failedStep).toBeUndefined();
  expect(result.frameSnap).toBe('selector');
  expect(Object.keys(result.boxes)).toEqual(['in']);
  expect(result.missed).toEqual([{ key: 'hidden', reason: 'not-visible' }]);
});

test('when every target is hidden each is missed as not-visible and nothing is written', async ({ startClient, server }, testInfo) => {
  const { capture, captureDir } = await start(startClient, server, testInfo, `<body><p data-testid="a" style="display:none">A</p><p data-testid="b" style="display:none">B</p></body>`);
  const result = await capture({ targets: { a: '[data-testid=a]', b: '[data-testid=b]' }, out: 'all-hidden' });
  expect(result).toEqual({ failedStep: 'measure', missed: [{ key: 'a', reason: 'not-visible' }, { key: 'b', reason: 'not-visible' }] });
  expect(fs.existsSync(path.join(captureDir, 'all-hidden.png'))).toBe(false);
});

for (const [name, background, dark] of [
  ['a near-white oklch card', 'oklch(0.985 0.002 247.839)', false],
  ['a near-black oklch card', 'oklch(0.18 0.02 270)', true],
  ['a near-white color(srgb) card', 'color(srgb 0.97 0.97 0.97)', false],
] as const) {
  test(`${name} is ${dark ? 'dark' : 'not dark'}`, async ({ startClient, server }, testInfo) => {
    const { capture } = await start(startClient, server, testInfo, `<body style="margin:0;background:transparent">
      <section style="margin:24px;padding:16px;width:400px;border:1px solid #889;min-height:80px;background:${background}"><p data-testid="value">Status: shipped</p></section></body>`);
    const result = await capture({ targets: { value: '[data-testid=value]' }, out: 'modern-colour' });
    expect(result.frameSnap).toBe('card');
    expect(result.dark).toBe(dark);
  });
}

const GEOMETRY = `<body style="margin:0;background:#fff">
  <section data-testid="card" style="position:absolute;left:100px;top:100px;width:300px;height:120px;box-sizing:border-box;border:1px solid #ccd;background:#fff">
    <div data-testid="inner" style="position:absolute;left:20px;top:20px;width:50px;height:30px;background:#2563eb"></div></section>
  <div data-testid="far-a" style="position:absolute;left:600px;top:400px;width:100px;height:40px"></div>
  <div data-testid="far-b" style="position:absolute;left:800px;top:550px;width:80px;height:50px"></div></body>`;

test('a card snap frames the card with 12px of padding', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo, GEOMETRY);
  const result = await capture({ targets: { inner: '[data-testid=inner]' }, out: 'geometry-card' });
  expect(result.frameSnap).toBe('card');
  expect(result.boxes.inner).toEqual([121, 121, 50, 30]);
  expect(result.frame).toEqual([88, 88, 324, 144]);
});

test('a union snap frames the targets with 24px of padding', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo, GEOMETRY);
  const result = await capture({ targets: { a: '[data-testid=far-a]', b: '[data-testid=far-b]' }, out: 'geometry-union' });
  expect(result.frameSnap).toBe('union');
  expect(result.frame).toEqual([576, 376, 328, 248]);
});

test('a selector snap frames the chosen element with 12px of padding', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo, GEOMETRY);
  const result = await capture({ frame: '[data-testid=card]', targets: { inner: '[data-testid=inner]' }, out: 'geometry-selector' });
  expect(result.frameSnap).toBe('selector');
  expect(result.frame).toEqual([88, 88, 324, 144]);
});

// A tab strip whose tab link runs past the strip's bottom edge by `overhang` px, as an active tab's outline does.
const tabStrip = (overhang: number) => `<body style="margin:0;background:#fff">
  <nav data-testid="strip" style="position:absolute;left:100px;top:100px;width:400px;height:40px;background:#eef">
    <a data-testid="tab" href="#" style="position:absolute;left:20px;top:4px;width:80px;height:${36 + overhang}px">Builds</a></nav></body>`;

const holdsEveryBox = (sidecar: any) => Object.values(sidecar.boxes as Record<string, number[]>).every(([x, y, w, h]) => {
  const [fx, fy, fw, fh] = sidecar.frame;
  return x >= fx && y >= fy && x + w <= fx + fw && y + h <= fy + fh;
});

for (const overhang of [2, 8]) {
  test(`a target that overhangs the frame selector by ${overhang}px is captured, and the frame holds its box`, async ({ startClient, server }, testInfo) => {
    const { capture } = await start(startClient, server, testInfo, tabStrip(overhang));
    const result = await capture({ frame: '[data-testid=strip]', targets: { tab: '[data-testid=tab]' }, out: `overhang-${overhang}` });
    expect(result.failedStep).toBeUndefined();
    expect(result.frameSnap).toBe('selector');
    expect(result.boxes.tab).toEqual([120, 104, 80, 36 + overhang]);
    const sidecar = JSON.parse(fs.readFileSync(result.sidecar, 'utf8'));
    expect(holdsEveryBox(sidecar)).toBe(true);
  });
}

test('a target that overhangs the frame selector by 9px is refused', async ({ startClient, server }, testInfo) => {
  const { capture, captureDir } = await start(startClient, server, testInfo, tabStrip(9));
  expect(await capture({ frame: '[data-testid=strip]', targets: { tab: '[data-testid=tab]' }, out: 'overhang-9' }))
      .toEqual({ failedStep: 'frame', error: 'the frame selector does not contain every target' });
  expect(fs.existsSync(path.join(captureDir, 'overhang-9.png'))).toBe(false);
});

// The frame sits 8px inside the 1000x700 viewport on every side, so the 12px pad is clamped at each edge.
// The targets share one edge because placeFrame refuses targets spread over more than 90% of the viewport height.
for (const [edge, y] of [['top', 0], ['bottom', 670]] as const) {
  test(`targets that overhang a frame selector into the ${edge} viewport corners stay inside the clamped frame`, async ({ startClient, server }, testInfo) => {
    const { capture } = await start(startClient, server, testInfo, `<body style="margin:0;overflow:hidden;background:#fff">
      <section data-testid="panel" style="position:absolute;left:8px;top:8px;width:984px;height:684px;background:#eef">
        <div data-testid="left" style="position:absolute;left:-8px;${edge}:-8px;width:40px;height:30px;background:#2563eb"></div>
        <div data-testid="right" style="position:absolute;right:-8px;${edge}:-8px;width:40px;height:30px;background:#2563eb"></div></section></body>`);
    const result = await capture({ frame: '[data-testid=panel]', targets: { left: '[data-testid=left]', right: '[data-testid=right]' }, out: `overhang-${edge}` });
    expect(result.failedStep).toBeUndefined();
    expect(result.missed).toEqual([]);
    expect(result.boxes).toEqual({ left: [0, y, 40, 30], right: [960, y, 40, 30] });
    expect(result.frame).toEqual([0, 0, 1000, 700]);
    const sidecar = JSON.parse(fs.readFileSync(result.sidecar, 'utf8'));
    expect(holdsEveryBox(sidecar)).toBe(true);
  });
}

test('a hidden first target does not cost the five-second visibility wait', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo, `<body><p data-testid="hidden" style="display:none">Hidden</p><p data-testid="shown">Shown</p></body>`);
  const started = Date.now();
  const result = await capture({ targets: { hidden: '[data-testid=hidden]', shown: '[data-testid=shown]' }, out: 'first-hidden' });
  expect(result.missed).toEqual([{ key: 'hidden', reason: 'not-visible' }]);
  expect(Date.now() - started).toBeLessThan(4000);
});

test('a pinch-zoomed page is refused before any screenshot', async ({ startClient, server, mcpBrowser }, testInfo) => {
  test.skip(!isChromium(mcpBrowser), 'the 2x path is Chromium only');
  const { client, capture, captureDir } = await start(startClient, server, testInfo);
  const zoomed = await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: `async page => { const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 }); }` } });
  expect(zoomed.isError).toBeFalsy();
  const result = await capture({ targets: { owner: '[data-testid=owner]' }, out: 'pinched' });
  expect(result.isError).toBe(true);
  expect(result.text).toContain('the page is pinch-zoomed; reset it to 100% and capture again');
  expect(fs.existsSync(path.join(captureDir, 'pinched.png'))).toBe(false);
  await expectNoTags(client);
});

test('a capture that cannot be written leaves no temporary file behind', async ({ startClient, server }, testInfo) => {
  const { capture, captureDir } = await start(startClient, server, testInfo);
  fs.mkdirSync(path.join(captureDir, 'blocked.png'), { recursive: true });
  const result = await capture({ targets: { owner: '[data-testid=owner]' }, out: 'blocked' });
  expect(result.isError).toBe(true);
  expect(fs.readdirSync(captureDir).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

test('a page without a working 2D canvas still captures, and dark is false', async ({ startClient, server }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo, `<body style="margin:0;background:#0b0920;color:#fff">
    <script>HTMLCanvasElement.prototype.getContext = () => null;</script>
    <section style="margin:24px;padding:16px;width:400px;border:1px solid #445;min-height:80px"><p data-testid="value">Status: shipped</p></section></body>`);
  const result = await capture({ targets: { value: '[data-testid=value]' }, out: 'no-canvas' });
  expect(result.failedStep).toBeUndefined();
  expect(result.isError).toBeUndefined();
  expect(result.dark).toBe(false);
});

test('an override capture whose page hangs at 2x says the page may still be at the capture scale', async ({ startClient, server, mcpBrowser }, testInfo) => {
  test.skip(!isChromium(mcpBrowser), 'the override strategy is Chromium only');
  test.setTimeout(30_000);
  const script = `<script>matchMedia('(min-resolution: 2dppx)').addEventListener('change', e => { if (e.matches) for (;;) {} });</script>`;
  const { capture } = await start(startClient, server, testInfo, `${SHARP}${script}`, { env: { PLAYWRIGHT_MCP_CAPTURE_2X: 'override', PLAYWRIGHT_MCP_CAPTURE_TIMEOUT: '1500' } });
  const result = await capture({ targets: { line: '[data-testid=line]' }, out: 'hung-at-2x' });
  expect(result.isError).toBe(true);
  expect(result.text).toContain('capture timed out after 1500ms at screenshot; the page may still be at the capture\'s device scale');
});

test('an override capture succeeds when the page grows below the fold without moving the target', async ({ startClient, server, mcpBrowser }, testInfo) => {
  test.skip(!isChromium(mcpBrowser), 'the override strategy is Chromium only');
  const script = `<script>const measure = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { const row = document.createElement('div'); row.style.height = '10px'; document.body.append(row); return measure.call(this); };</script>`;
  const { capture } = await start(startClient, server, testInfo, `${SHARP}<div style="height:1500px"></div>${script}`, { env: { PLAYWRIGHT_MCP_CAPTURE_2X: 'override' } });
  const result = await capture({ targets: { line: '[data-testid=line]' }, out: 'grows' });
  expect(result.isError).toBeUndefined();
  expect(result.scale).toBe(2);
  expect(Object.keys(result.boxes)).toEqual(['line']);
});

test('a tagged target the page replaces before the measurement fails the capture instead of vanishing', async ({ startClient, server }, testInfo) => {
  const { client, capture, captureDir } = await start(startClient, server, testInfo, `<body style="margin:24px"><p data-testid="a">One</p><p data-testid="b">Two</p>
    <script>const measure = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        const tagged = document.querySelector('[data-testid=b][data-ev-key]');
        if (tagged) { const fresh = tagged.cloneNode(true); fresh.removeAttribute('data-ev-key'); tagged.replaceWith(fresh); }
        return measure.call(this);
      };</script></body>`);
  const result = await capture({ targets: { a: '[data-testid=a]', b: '[data-testid=b]' }, out: 'replaced' });
  expect(result.isError).toBe(true);
  expect(result.text).toContain('the page moved while it was captured; capture again');
  expect(fs.existsSync(path.join(captureDir, 'replaced.png'))).toBe(false);
  expect(fs.existsSync(path.join(captureDir, 'replaced.capture.json'))).toBe(false);
  await expectNoTags(client);
});

test('the digest covers the scale unless it is 1', async ({ startClient, server, mcpBrowser }, testInfo) => {
  const { capture } = await start(startClient, server, testInfo);
  const result = await capture({ targets: { owner: '[data-testid=owner]' }, out: 'digest-scale' });
  const sidecar = JSON.parse(fs.readFileSync(result.sidecar, 'utf8'));
  const png = fs.readFileSync(result.png);
  // Chromium captures at 2x and the other engines at 1x, so the projects together cover both branches.
  expect(sidecar.scale).toBe(isChromium(mcpBrowser) ? 2 : 1);
  const without = crypto.createHash('sha256').update(png).update(JSON.stringify({ frame: sidecar.frame, boxes: sidecar.boxes })).digest('hex');
  const withScale = crypto.createHash('sha256').update(png).update(JSON.stringify({ frame: sidecar.frame, boxes: sidecar.boxes, scale: sidecar.scale })).digest('hex');
  expect(sidecar.digest).toBe(sidecar.scale === 1 ? without : withScale);
  if (sidecar.scale !== 1)
    expect(sidecar.digest).not.toBe(without);
});
