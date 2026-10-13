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

import * as z from 'zod';

import { outputDir } from './context';
import { defineTabTool } from './tool';

import type * as playwright from '../../..';
import type { Tab } from './tab';

const SCHEMA = 'capture-evidence/1';
const OUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CALL_TIMEOUT_MS = 10_000;
const SETTLE_MS = 350;

type Box = [number, number, number, number];
type Missed = { key: string, reason: 'no-match' | 'ambiguous' | 'not-visible' | 'out-of-view', count?: number };
type Failure = { failedStep: 'args' | 'resolve' | 'frame' | 'measure', error?: string, missed?: Missed[], frameSnap?: 'too-large' };
type Shot = { png: Buffer, scale: 1 | 2, width: number, height: number };

const captureSchema = z.object({
  targets: z.record(z.string(), z.string()).describe('Elements to measure: a short key for each, mapped to a selector that matches exactly one element.'),
  frame: z.string().default('auto').describe('"auto" crops to the nearest card that holds every target. A selector crops to that element instead; it must match one element, contain every target and fit the viewport.'),
  out: z.string().describe('Base file name of the capture, for example "board.c1". The tool writes <out>.png and <out>.capture.json.'),
});

function callTimeout(): number {
  const value = Number(process.env.PLAYWRIGHT_MCP_CAPTURE_TIMEOUT);
  return Number.isFinite(value) && value > 0 ? value : CALL_TIMEOUT_MS;
}

// Every browser call in a capture goes through here, so no relay stall can hang the tool.
async function bounded<T>(step: string, work: Promise<T>): Promise<T> {
  const ms = callTimeout();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`capture timed out after ${ms}ms at ${step}`)), ms);
  });
  // The call may still fail after the deadline has already been reported.
  work.catch(() => {});
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

// The functions below are serialized into the page: each may reference nothing outside its own body.

function clearTags() {
  document.querySelectorAll('[data-ev-key]').forEach(e => e.removeAttribute('data-ev-key'));
  document.querySelectorAll('[data-ev-frame]').forEach(e => e.removeAttribute('data-ev-frame'));
}

function checkFrame() {
  const f = document.querySelector('[data-ev-frame]')!.getBoundingClientRect();
  // A hidden target has no rectangle to contain; measuring reports it as not visible.
  const contains = Array.from(document.querySelectorAll('[data-ev-key]')).every(e => {
    const r = e.getBoundingClientRect();
    return r.width <= 0 || r.height <= 0 || r.left >= f.left - 1 && r.top >= f.top - 1 && r.right <= f.right + 1 && r.bottom <= f.bottom + 1;
  });
  return { contains, fits: f.width <= innerWidth && f.height <= innerHeight };
}

function placeFrame() {
  const sized = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const elements = Array.from(document.querySelectorAll('[data-ev-key]')).filter(sized);
  // Nothing to frame: measuring reports every target as not visible.
  if (!elements.length)
    return { snap: 'union' as const };
  const rects = elements.map(e => e.getBoundingClientRect());
  const x = Math.min(...rects.map(r => r.left)); const y = Math.min(...rects.map(r => r.top));
  const u = { w: Math.max(...rects.map(r => r.right)) - x, h: Math.max(...rects.map(r => r.bottom)) - y };
  if (u.w > innerWidth || u.h > innerHeight * 0.9)
    return { snap: 'too-large' as const };
  let chosen = document.querySelector('[data-ev-frame]');
  let snap: 'selector' | 'card' | 'union' = chosen ? 'selector' : 'card';
  if (!chosen) {
    const chain = (e: Element) => {
      const list: Element[] = [];
      for (let n: Element | null = e; n; n = n.parentElement)
        list.push(n);
      return list;
    };
    const common = chain(elements[0]).find(n => elements.every(e => n.contains(e)));
    for (let n: Element | null | undefined = common; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n); const r = n.getBoundingClientRect();
      const edged = parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderBottomWidth) > 0 || s.boxShadow !== 'none'
        || (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent');
      // A heading-only strip is not a card: require room for content beyond the targets themselves.
      const roomy = r.height >= Math.max(64, u.h + 24) && r.width >= 120;
      if (edged && roomy && r.width <= innerWidth && r.height <= innerHeight * 0.9) { chosen = n; break; }
    }
    if (!chosen)
      snap = 'union';
  }
  if (chosen) { chosen.setAttribute('data-ev-frame', ''); chosen.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } else { elements[0].scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); }
  return { snap };
}

function measureTagged() {
  const rect = (e: Element) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(Math.round); };
  const boxes: [string, number[]][] = [];
  for (const e of Array.from(document.querySelectorAll('[data-ev-key]'))) {
    for (const key of JSON.parse(e.getAttribute('data-ev-key')!) as string[])
      boxes.push([key, rect(e)]);
  }
  const f = document.querySelector('[data-ev-frame]');
  let dark = false;
  // Computed colours keep modern syntaxes as written, so the browser resolves them to bytes. A page that cannot do that is reported as not dark.
  try {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    for (let n: Element | null = f ?? document.querySelector('[data-ev-key]'); n; n = n.parentElement) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = 'rgba(0, 0, 0, 0)';
      context.fillStyle = getComputedStyle(n).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      if (a > 127) { dark = (0.299 * r + 0.587 * g + 0.114 * b) < 110; break; }
    }
  } catch {
    dark = false;
  }
  return { boxes, frame: f ? rect(f) : null, dark };
}

function layoutFingerprint() {
  const numbers: number[] = [];
  const add = (e: Element) => { const b = e.getBoundingClientRect(); numbers.push(b.x, b.y, b.width, b.height); };
  const frame = document.querySelector('[data-ev-frame]');
  if (frame)
    add(frame);
  document.querySelectorAll('[data-ev-key]').forEach(add);
  numbers.push(scrollX, scrollY);
  return numbers;
}

function pngSize(png: Buffer) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

type FrameSession = { _client: { send: (method: string, params?: object) => Promise<any> }, _metricsOverride?: Record<string, unknown> & { deviceScaleFactor?: number } };

type ServerPage = { browserContext?: { _browser?: { options?: { name?: string } } }, delegate?: { _mainFrameSession?: FrameSession } };

function serverPageOf(page: playwright.Page): ServerPage | undefined {
  // eslint-disable-next-line no-restricted-syntax -- the page's existing CDP session is only reachable on the in-process server objects; a new session would kill the extension relay.
  return (page as any)._connection?.toImpl?.(page);
}

function layoutDiffers(a: number[], b: number[]) {
  return a.length !== b.length || a.some((value, i) => Math.abs(value - b[i]) > 0.5);
}

const MOVED_ERROR = 'the page moved while it was captured; capture again';
const REFLOW_ERROR = 'the page lays out differently at 2x, so the capture cannot be aligned with its boxes';

async function shoot(page: playwright.Page): Promise<Shot> {
  const serverPage = serverPageOf(page);
  const browserName = serverPage?.browserContext?._browser?.options?.name;
  // Only a browser other than Chromium may lose 2x; on Chromium a missing session is a fault to report.
  if (browserName && browserName !== 'chromium') {
    const png = await bounded('screenshot', page.screenshot({ type: 'png', scale: 'css' }));
    return { png, scale: 1, ...pngSize(png) };
  }
  const frameSession = serverPage?.delegate?._mainFrameSession;
  if (typeof frameSession?._client?.send !== 'function')
    throw new Error('the page\'s own browser session is not reachable, so a 2x capture is not possible');
  const client = frameSession._client;
  const metrics = await bounded('screenshot', client.send('Page.getLayoutMetrics'));
  const view = metrics.cssVisualViewport;
  // The clip is the visual viewport while the boxes are layout coordinates, so a zoomed page would not line up.
  if (view.scale !== 1)
    throw new Error('the page is pinch-zoomed; reset it to 100% and capture again');
  const clip = { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight };
  const override = frameSession._metricsOverride;
  // Same rule as CRPage.takeScreenshot: an emulated device scale does not show in the layout metrics.
  const deviceScale = override?.deviceScaleFactor || metrics.contentSize.width / metrics.cssContentSize.width || 1;
  const take = async (scale: number) => {
    const result = await bounded('screenshot', client.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale }, captureBeyondViewport: false }));
    return Buffer.from(result.data, 'base64');
  };
  const forced = process.env.PLAYWRIGHT_MCP_CAPTURE_2X;
  // 2 / deviceScale is exact only at 1 and 2; at any other scale the image could round a pixel off.
  const useOverride = forced === 'override' || (forced !== 'clip' && deviceScale !== 1 && deviceScale !== 2);
  let png: Buffer;
  if (useOverride) {
    let pending: { error: unknown } | undefined;
    let taken: Buffer | undefined;
    const before = await bounded('screenshot', page.evaluate(layoutFingerprint));
    const moved = (other: number[]) => layoutDiffers(before, other);
    try {
      await bounded('screenshot', client.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, mobile: false, ...override, deviceScaleFactor: 2 }));
      taken = await take(1);
      const afterView = (await bounded('screenshot', client.send('Page.getLayoutMetrics'))).cssVisualViewport;
      if (afterView.clientWidth !== clip.width || afterView.clientHeight !== clip.height)
        throw new Error(REFLOW_ERROR);
      if (moved(await bounded('screenshot', page.evaluate(layoutFingerprint))))
        throw new Error(REFLOW_ERROR);
    } catch (error) {
      pending = { error };
    }
    // The page must be back at its own scale before any error leaves, and the original error outranks a failed restore.
    try {
      await bounded('screenshot', (async () => {
        // Setting the page's own override straight back leaves media-query styles stale; clearing first forces a restyle.
        await client.send('Emulation.clearDeviceMetricsOverride');
        if (override)
          await client.send('Emulation.setDeviceMetricsOverride', override);
      })());
    } catch {
      if (!pending)
        throw new Error('the page could not be returned to its own device scale after the capture');
      if (pending.error instanceof Error)
        pending.error.message += '; the page may still be at the capture\'s device scale';
    }
    if (pending)
      throw pending.error;
    png = taken!;
    // The boxes are measured after the override is gone, so a layout that differs from the original one, or that stays moved, would misalign them with the image.
    if (moved(await bounded('screenshot', page.evaluate(layoutFingerprint))))
      throw new Error(REFLOW_ERROR);
  } else {
    png = await take(2 / deviceScale);
  }
  const size = pngSize(png);
  // Chrome sizes the image as 2 x floor(the CSS viewport), so a fractional viewport loses up to two device pixels and never gains any.
  const fits = (pixels: number, css: number) => pixels >= 2 * Math.floor(css) && pixels <= Math.ceil(2 * css);
  if (!fits(size.width, clip.width) || !fits(size.height, clip.height))
    throw new Error(`the capture came back at ${size.width}x${size.height}, which is not twice the ${clip.width}x${clip.height} viewport`);
  return { png, scale: 2, ...size };
}

function captureDirectory(tab: Tab): string {
  const configured = tab.context.config.captureDir;
  return configured ? path.resolve(configured) : outputDir(tab.context.options);
}

async function writeAtomic(file: string, data: Buffer | string) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temp, data);
    await fs.promises.rename(temp, file);
  } catch (error) {
    // The write error is the one worth reporting, not a failed cleanup.
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function captureEvidence(tab: Tab, params: z.output<typeof captureSchema>): Promise<Failure | Record<string, unknown>> {
  const { targets, frame, out } = params;
  if (!OUT_NAME.test(out))
    return { failedStep: 'args', error: 'out must be a simple file name' };
  const keys = Object.keys(targets);
  if (!keys.length)
    return { failedStep: 'args', error: 'targets is required' };
  const page = tab.page;
  // Tags left by an earlier call on this page would corrupt this one.
  await bounded('cleanup', page.evaluate(clearTags));
  try {
    await bounded('resolve', page.locator(targets[keys[0]]).first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {}));
    const missed: Missed[] = [];
    const taggedKeys: string[] = [];
    for (const key of keys) {
      const locator = page.locator(targets[key]);
      const count = await bounded('resolve', locator.count());
      if (count !== 1) {
        missed.push(count === 0 ? { key, reason: 'no-match' } : { key, reason: 'ambiguous', count });
        continue;
      }
      const taggable = await bounded('resolve', locator.evaluate((element, k) => {
        // The page-side steps search the top document only, so an element outside it must not be tagged.
        if (element.getRootNode() !== element.ownerDocument || window !== window.top)
          return false;
        // One element can answer to several keys, so the attribute holds a JSON array.
        const keys: string[] = JSON.parse(element.getAttribute('data-ev-key') || '[]');
        element.setAttribute('data-ev-key', JSON.stringify([...keys, k]));
        return true;
      }, key, { timeout: 2000 }));
      if (!taggable)
        return { failedStep: 'resolve', error: 'a target inside a shadow root or an iframe cannot be captured' };
      taggedKeys.push(key);
    }
    if (!taggedKeys.length)
      return { failedStep: 'resolve', missed };

    if (frame !== 'auto') {
      const frameLocator = page.locator(frame);
      if (await bounded('frame', frameLocator.count()) !== 1)
        return { failedStep: 'frame', error: 'the frame selector must match exactly one element' };
      const taggable = await bounded('frame', frameLocator.evaluate(element => {
        if (element.getRootNode() !== element.ownerDocument || window !== window.top)
          return false;
        element.setAttribute('data-ev-frame', '');
        return true;
      }, undefined, { timeout: 2000 }));
      if (!taggable)
        return { failedStep: 'frame', error: 'a frame inside a shadow root or an iframe cannot be captured' };
      const fit = await bounded('frame', page.evaluate(checkFrame));
      if (!fit.contains)
        return { failedStep: 'frame', error: 'the frame selector does not contain every target' };
      if (!fit.fits)
        return { failedStep: 'frame', error: 'the frame selector is larger than the viewport' };
    }
    const placed = await bounded('frame', page.evaluate(placeFrame));
    if (placed.snap === 'too-large')
      return { failedStep: 'frame', frameSnap: 'too-large', error: 'the targets cannot share one viewport-sized frame' };
    const frameSnap = frame !== 'auto' ? 'selector' : placed.snap;
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS));

    // Screenshot first, then measure, with nothing page-changing in between.
    const before = await bounded('screenshot', page.evaluate(layoutFingerprint));
    const shot = await shoot(page);
    const measured = await bounded('measure', page.evaluate(measureTagged));
    const after = await bounded('measure', page.evaluate(layoutFingerprint));
    // A tagged node the page replaced would otherwise drop its key without a trace.
    const measuredKeys = new Set((measured.boxes as [string, Box][]).map(([key]) => key));
    if (layoutDiffers(before, after) || taggedKeys.some(key => !measuredKeys.has(key)))
      throw new Error(MOVED_ERROR);
    const viewport = { w: shot.width / shot.scale, h: shot.height / shot.scale };
    const boxes: Record<string, Box> = {};
    for (const [key, box] of measured.boxes as [string, Box][]) {
      if (box[2] <= 0 || box[3] <= 0) { missed.push({ key, reason: 'not-visible' }); continue; }
      if (box[0] < 0 || box[0] + box[2] > viewport.w || box[1] < 0 || box[1] + box[3] > viewport.h) { missed.push({ key, reason: 'out-of-view' }); continue; }
      boxes[key] = box;
    }
    const values = Object.values(boxes);
    if (!values.length)
      return { failedStep: 'measure', missed };
    const left = Math.min(...values.map(b => b[0])); const top = Math.min(...values.map(b => b[1]));
    const base = (measured.frame as Box | null) ?? [left, top,
      Math.max(...values.map(b => b[0] + b[2])) - left, Math.max(...values.map(b => b[1] + b[3])) - top];
    const pad = frameSnap === 'union' ? 24 : 12;
    const fx = Math.max(0, base[0] - pad); const fy = Math.max(0, base[1] - pad);
    const frameBox: Box = [fx, fy,
      Math.min(viewport.w, base[0] + base[2] + pad) - fx, Math.min(viewport.h, base[1] + base[3] + pad) - fy];

    const image = `${out}.png`;
    const digest = crypto.createHash('sha256').update(shot.png).update(JSON.stringify({ frame: frameBox, boxes })).digest('hex');
    const body = { schemaVersion: SCHEMA, source: 'live', image, frame: frameBox, frameSnap, boxes, missed, dark: measured.dark, scale: shot.scale, digest };
    const dir = captureDirectory(tab);
    await fs.promises.mkdir(dir, { recursive: true });
    const pngPath = path.join(dir, image);
    const sidecarPath = path.join(dir, `${out}.capture.json`);
    await writeAtomic(pngPath, shot.png);
    await writeAtomic(sidecarPath, `${JSON.stringify(body, null, 2)}\n`);
    return { ...body, png: pngPath, sidecar: sidecarPath };
  } finally {
    await bounded('cleanup', page.evaluate(clearTags)).catch(() => {});
  }
}

const captureEvidenceTool = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_capture_evidence',
    title: 'Capture evidence',
    description: 'Screenshot the viewport at 2x and measure named elements for `fast-browser compose`. Writes the PNG and its capture sidecar, and returns the sidecar fields with both paths. A selector that matches no element, or several, is listed in `missed` and never guessed.',
    inputSchema: captureSchema,
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    response.addTextResult(JSON.stringify(await captureEvidence(tab, params), null, 2));
  },
});

export default [
  captureEvidenceTool,
];
