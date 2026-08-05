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
import crypto from 'crypto';

import { test, expect, parseResponse } from './fixtures';

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

test('a trace-write failure does not affect the tool response', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const actionsFile = path.join(outputDir, traceDir, 'actions.jsonl');

  // Make the trace file unwritable so the next appendRecord() throws (EACCES),
  // simulating ENOSPC / output-dir-removed style failures.
  await fs.promises.chmod(actionsFile, 0o444);
  try {
    const result = await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
    expect(result.isError).toBeFalsy();
  } finally {
    await fs.promises.chmod(actionsFile, 0o644);
  }
});

test('network activity and mutation classification recorded per action', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  server.setContent('/form.html', `
    <button id="post" onclick="fetch('/api/submit', { method: 'POST', body: 'x=1' })">Submit</button>
    <button id="get" onclick="fetch('/api/read')">Read</button>`, 'text/html');
  server.setContent('/api/submit', 'ok', 'text/plain');
  server.setContent('/api/read', 'ok', 'text/plain');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/form.html' } });
  const snap = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const snapshotText = parseResponse(snap, outputDir)?.inlineSnapshot ?? '';
  const postRef = /"Submit"\s*\[ref=(e\d+)\]/.exec(snapshotText)![1];
  const getRef = /"Read"\s*\[ref=(e\d+)\]/.exec(snapshotText)![1];
  await client.callTool({ name: 'browser_click', arguments: { element: 'Submit button', target: postRef } });
  await client.callTool({ name: 'browser_click', arguments: { element: 'Read button', target: getRef } });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const lines = fs.readFileSync(path.join(outputDir, traceDir, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const postClick = lines.find(l => l.tool === 'browser_click' && l.params.target === postRef);
  const getClick = lines.find(l => l.tool === 'browser_click' && l.params.target === getRef);
  expect(postClick.network.some((n: any) => n.method === 'POST' && n.url.includes('/api/submit'))).toBe(true);
  expect(postClick.mutating).toBe(true);
  expect(getClick.mutating).toBe(false);
  expect(postClick.waits.settleMs).toBeGreaterThanOrEqual(0);
});

test('a dialog-interrupted action does not leak stale telemetry onto a later trace record', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  // The handler fires a request, then opens the alert asynchronously (after
  // the request settles). The click tool call's own waitForCompletion races
  // against the modal-state event and loses: Tab.waitForCompletion returns
  // early (see Tab._raceAgainstModalStates) while the click's underlying
  // waitForCompletion() call keeps running in the background, blocked, since
  // the alert stalls the page until it is dismissed. It can only reach
  // setActionTelemetry once browser_handle_dialog accepts the dialog on a
  // later, separate tool call.
  server.setContent('/dialog.html', `
    <button id="alertBtn" onclick="fetch('/api/before-alert').then(() => alert('Alert'))">Alert</button>`, 'text/html');
  server.setContent('/api/before-alert', 'ok', 'text/plain');
  // A short settle window keeps the interrupted action's backgrounded work
  // (and this test) fast, without changing the shape of the race.
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`, '--timeout-settle=5'] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/dialog.html' } });
  const snap = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const snapshotText = parseResponse(snap, outputDir)?.inlineSnapshot ?? '';
  const alertRef = /"Alert"\s*\[ref=(e\d+)\]/.exec(snapshotText)![1];

  const clickResult = await client.callTool({ name: 'browser_click', arguments: { element: 'Alert button', target: alertRef } });
  // Confirms the click really was interrupted by the modal (i.e. this test
  // actually exercises the race, not a false positive from the alert firing
  // too late to matter).
  expect(parseResponse(clickResult)?.modalState).toContain('dialog');

  await client.callTool({ name: 'browser_handle_dialog', arguments: { accept: true } });
  // Poll with telemetry-less calls: the interrupted click's backgrounded
  // action can only reach setActionTelemetry once the dialog above is
  // handled, and exactly when it does is not deterministic, so every call
  // in this window is a candidate for inheriting its stale data.
  for (let i = 0; i < 40; i++)
    await client.callTool({ name: 'browser_snapshot', arguments: {} });

  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const lines = fs.readFileSync(path.join(outputDir, traceDir, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const dialogIndex = lines.findIndex((l: any) => l.tool === 'browser_handle_dialog');
  expect(dialogIndex).toBeGreaterThanOrEqual(0);
  const afterDialog = lines.slice(dialogIndex + 1);
  expect(afterDialog.length).toBeGreaterThan(0);
  const contaminated = afterDialog.some((l: any) => l.network.some((n: any) => n.url.includes('/api/before-alert')));
  expect(contaminated).toBe(false);
});

test('click records target with locator alternates and accessible role/name', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  server.setContent('/target.html', `<nav><button data-testid="export-btn" aria-describedby="hint">Export</button><span id="hint">Exports the report</span></nav>`, 'text/html');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`, '--test-id-attribute=data-testid'] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/target.html' } });
  const snap = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const snapshotText = parseResponse(snap, outputDir)?.inlineSnapshot ?? '';
  const ref = /"Export"\s*\[ref=(e\d+)\]/.exec(snapshotText)![1];
  await client.callTool({ name: 'browser_click', arguments: { element: 'Export button', target: ref } });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const lines = fs.readFileSync(path.join(outputDir, traceDir, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const click = lines.find(l => l.tool === 'browser_click');
  expect(click.targets.length).toBe(1);
  const target = click.targets[0];
  expect(target.ref).toBe(ref);
  expect(target.role).toBe('button');
  expect(target.name).toBe('Export');
  expect(target.description).toBe('Exports the report');
  // A unique, configured-attribute testid always wins generateSelector's
  // scoring (Task 4 concern #4): `multiple: true` produces a `withText` and
  // a `withoutText` token, both testid, which dedupe to exactly one
  // candidate -- there is no role/css alternate to collapse away. Verified
  // directly against this fixture with a throwaway `_selectorCandidates()`
  // probe before writing this assertion; the multi-kind case (role + css)
  // is covered separately below for an element with no testid.
  const kinds = target.alternates.map((a: any) => a.kind);
  expect(kinds).toEqual(['testid']);
});

test('browser_snapshot (read-only) records empty targets, not an enriched action', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  server.setContent('/plain.html', `<button id="btn">Click me</button>`, 'text/html');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/plain.html' } });
  const snap = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const snapshotText = parseResponse(snap, outputDir)?.inlineSnapshot ?? '';
  const ref = /"Click me"\s*\[ref=(e\d+)\]/.exec(snapshotText)![1];
  // browser_snapshot's own `target` param (snapshot.ts:52-53) resolves a real
  // locator through tab.targetLocator -- the same shared resolution code the
  // 5 enriched tools call -- but this call site never passes { trace: true }.
  // Without a target param the handler skips targetLocator entirely (see the
  // no-target call above), which would leave this differentiator unproven:
  // this second call must actually reach targetLocator and still come back
  // empty, or a regression that flips the opt-in default would go uncaught.
  await client.callTool({ name: 'browser_snapshot', arguments: { target: ref } });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const lines = fs.readFileSync(path.join(outputDir, traceDir, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const snapshotRecords = lines.filter(l => l.tool === 'browser_snapshot');
  expect(snapshotRecords.length).toBe(2);
  for (const record of snapshotRecords)
    expect(record.targets).toEqual([]);
});

test('a bare selector candidate with no engine prefix maps to kind css, not other', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  server.setContent('/save.html', `<button id="save-btn">Save changes</button>`, 'text/html');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/save.html' } });
  const snap = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const snapshotText = parseResponse(snap, outputDir)?.inlineSnapshot ?? '';
  const ref = /"Save changes"\s*\[ref=(e\d+)\]/.exec(snapshotText)![1];
  await client.callTool({ name: 'browser_click', arguments: { element: 'Save button', target: ref } });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const lines = fs.readFileSync(path.join(outputDir, traceDir, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const click = lines.find(l => l.tool === 'browser_click');
  const cssAlternate = click.targets[0].alternates.find((a: any) => a.selector === '#save-btn');
  expect(cssAlternate).toBeTruthy();
  expect(cssAlternate.kind).toBe('css');
  expect(click.targets[0].alternates.some((a: any) => a.kind === 'other')).toBe(false);
});

test('drag records targets for both start and end elements', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  server.setContent('/drag.html', `<div id="src" draggable="true">Drag me</div><div id="dst">Drop here</div>`, 'text/html');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/drag.html' } });
  const snap = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const snapshotText = parseResponse(snap, outputDir)?.inlineSnapshot ?? '';
  const srcRef = /\[ref=(e\d+)\]:\s*Drag me/.exec(snapshotText)![1];
  const dstRef = /\[ref=(e\d+)\]:\s*Drop here/.exec(snapshotText)![1];
  await client.callTool({ name: 'browser_drag', arguments: { startElement: 'source', startTarget: srcRef, endElement: 'dest', endTarget: dstRef } });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const lines = fs.readFileSync(path.join(outputDir, traceDir, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const drag = lines.find(l => l.tool === 'browser_drag');
  expect(drag.targets.length).toBe(2);
  expect(drag.targets[0].ref).toBe(srcRef);
  expect(drag.targets[1].ref).toBe(dstRef);
});

test('run_code records script hash, args, and internal API actions', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  server.setContent('/app.html', `<button onclick="this.textContent='done'">Run</button>`, 'text/html');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/app.html' } });
  const code = `async (page, args) => { await page.getByRole('button', { name: 'Run' }).click(); return await page.getByRole('button').textContent(); }`;
  await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code, args: { who: 'test' } } });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const lines = fs.readFileSync(path.join(outputDir, traceDir, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const rec = lines.find(l => l.tool === 'browser_run_code_unsafe');
  expect(rec.script.sha256).toBe(crypto.createHash('sha256').update(code).digest('hex'));
  expect(rec.script.args).toEqual({ who: 'test' });
  const apiNames = rec.script.actions.map((a: any) => a.apiName);
  expect(apiNames.some((n: string) => /click/i.test(n))).toBe(true);
});

test('oversized param values are truncated in the record', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  const big = 'x'.repeat(100 * 1024);
  await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: `async (page, args) => args.big.length`, args: { big } } });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const lines = fs.readFileSync(path.join(outputDir, traceDir, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const rec = lines.find(l => l.tool === 'browser_run_code_unsafe');
  expect(rec.script.args.big.__truncated__).toBe(true);
  expect(rec.script.args.big.sizeBytes).toBe(100 * 1024);
});

test('meta.json gains endedAt when the client disconnects cleanly', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  await client.close();
  await expect.poll(() => {
    const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
    return JSON.parse(fs.readFileSync(path.join(outputDir, traceDir, 'meta.json'), 'utf-8')).endedAt;
  }).toBeTruthy();
});
