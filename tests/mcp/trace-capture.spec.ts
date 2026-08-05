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

import { tools } from '../../packages/playwright-core/lib/coreBundle';

const { TraceLog } = tools;

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

// The `--save-trace` absent -> no trace dir case is a product contract
// (a promise about default behavior), not an implementation detail of
// TraceLog -- it lives in tests/mcp/fast-browser-contract.spec.ts.

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

test('a request that never gets a response is recorded with failed: true, not left blank', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  // Port 1 is a reserved, essentially-never-bound TCP port -- the connection
  // is refused immediately, so request.response() resolves null (not a
  // throw) rather than hanging. That's the exact branch this covers: before
  // this fix, only the .catch() path set `failed`, so a request whose
  // promise resolves null (as a refused connection's does) landed with
  // neither `status` nor `failed` -- indistinguishable from "not yet
  // settled." See utils.ts's waitForCompletion.
  server.setContent('/fail.html', `<button onclick="fetch('http://127.0.0.1:1/x').catch(() => {})">Go</button>`, 'text/html');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/fail.html' } });
  const snap = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const snapshotText = parseResponse(snap, outputDir)?.inlineSnapshot ?? '';
  const ref = /"Go"\s*\[ref=(e\d+)\]/.exec(snapshotText)![1];
  await client.callTool({ name: 'browser_click', arguments: { element: 'Go button', target: ref } });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const lines = fs.readFileSync(path.join(outputDir, traceDir, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const click = lines.find(l => l.tool === 'browser_click');
  const entry = click.network.find((n: any) => n.url.includes('127.0.0.1:1'));
  expect(entry).toBeTruthy();
  expect(entry.failed).toBe(true);
  expect(entry.status).toBeUndefined();
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

test('fill_form records a target per field (IMPORTANT 6: seven enriched tools, not five)', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  server.setContent('/form2.html', `<label>Name <input id="name"></label>`, 'text/html');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/form2.html' } });
  const snap = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const snapshotText = parseResponse(snap, outputDir)?.inlineSnapshot ?? '';
  const ref = /textbox "Name"\s*\[ref=(e\d+)\]/.exec(snapshotText)![1];
  await client.callTool({
    name: 'browser_fill_form',
    arguments: { fields: [{ name: 'Name field', type: 'textbox', target: ref, value: 'Ada' }] },
  });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const lines = fs.readFileSync(path.join(outputDir, traceDir, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const fillForm = lines.find(l => l.tool === 'browser_fill_form');
  expect(fillForm.targets.length).toBe(1);
  expect(fillForm.targets[0].ref).toBe(ref);
  expect(fillForm.targets[0].role).toBe('textbox');
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

test('a record with individually-small fields whose aggregate exceeds 64 KB survives intact', async ({ startClient, server }, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { client } = await startClient({ args: ['--save-trace', `--output-dir=${outputDir}`] });
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.HELLO_WORLD } });
  // Individually well under the 64 KB truncation threshold on its own, but
  // this value lands in the record twice: once as record.params.args (the
  // raw call args) and once as record.script.args (Task 6: script.args
  // mirrors the raw args). Two ~40 KB copies push the record's aggregate
  // serialized size past 64 KB even though neither field alone does.
  // Regression coverage for the top-level container-collapse bug: the whole
  // record must never be replaced wholesale just because its total size is
  // large -- only a genuinely oversized individual value may be marked, and
  // nothing here is individually oversized.
  const notQuiteBig = 'y'.repeat(40 * 1024);
  await client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: `async (page, args) => args.notQuiteBig.length`, args: { notQuiteBig } } });
  const traceDir = fs.readdirSync(outputDir).find(f => f.startsWith('trace-'))!;
  const lines = fs.readFileSync(path.join(outputDir, traceDir, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const rec = lines.find(l => l.tool === 'browser_run_code_unsafe');
  expect(Buffer.byteLength(JSON.stringify(rec))).toBeGreaterThan(64 * 1024);
  expect(rec.seq).toBe(2);
  expect(rec.tool).toBe('browser_run_code_unsafe');
  expect(typeof rec.startedAt).toBe('string');
  expect(typeof rec.endedAt).toBe('string');
  expect(rec.params.args.notQuiteBig).toBe(notQuiteBig);
  expect(rec.script.args.notQuiteBig).toBe(notQuiteBig);
});

// Unit-level, no browser: exercises TraceLog.appendRecord()'s array-element
// truncation directly (traceLog.ts's truncateArrayIfOversized), the same way
// run-code-capture.spec.ts unit-tests scriptCapture.ts's overlap guard.
// Driving a real `network` array past 64 KB end-to-end would mean firing
// hundreds of real requests inside one action's window -- slow and, worse,
// indirect: this is a container-collapse regression test for the write path
// itself, not for request telemetry, so it goes straight at appendRecord().
// Scoped to this one test (not file-wide, unlike run-code-capture.spec.ts's
// file-level skip) since this file otherwise runs real browser tests that do
// need to run per-project.
test('an oversized array field survives as an array: real entries plus one trailing truncation marker', async ({ mcpBrowser }, testInfo) => {
  test.skip(mcpBrowser !== 'chrome', 'Channel-agnostic; doesn\'t touch a browser at all.');
  const outputDir = testInfo.outputPath('output');
  const traceLog = await TraceLog.create(
      { outputDir },
      testInfo.outputPath(),
      { clientName: 'test', runtimeVersion: '0.0.0-test' },
  );
  // ~71 bytes per serialized entry * 2000 ~= 142 KB, comfortably over the
  // 64 KB budget, and enough entries that a meaningful prefix survives
  // (not just "zero kept" or "all kept").
  const network = Array.from({ length: 2000 }, (_, i) => ({ method: 'GET', url: `https://example.com/${i}`, resourceType: 'fetch' }));
  expect(Buffer.byteLength(JSON.stringify(network))).toBeGreaterThan(64 * 1024);

  traceLog.appendRecord({
    v: 1,
    seq: traceLog.nextSeq(),
    tool: 'browser_click',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    params: {},
    targets: [],
    network,
    mutating: false,
    waits: { settleMs: 0, awaitedNavigation: false, awaitedRequests: 0 },
    code: [],
  });
  await traceLog.close();

  const lines = fs.readFileSync(path.join(traceLog.folder, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const record = lines[0];

  // Identity core intact regardless of the oversized sibling field.
  expect(record.v).toBe(1);
  expect(record.seq).toBe(1);
  expect(record.tool).toBe('browser_click');
  expect(record.mutating).toBe(false);

  // The field stays a parseable array, not a bare marker object.
  expect(Array.isArray(record.network)).toBe(true);
  expect(record.network.length).toBeGreaterThan(1);
  expect(record.network.length).toBeLessThan(network.length);

  const marker = record.network[record.network.length - 1];
  expect(marker.__truncated__).toBe(true);
  expect(typeof marker.omittedElements).toBe('number');
  expect(marker.omittedElements).toBeGreaterThan(0);
  expect(marker.sizeBytes).toBe(Buffer.byteLength(JSON.stringify(network)));

  // Leading real entries are an intact, in-order prefix of the original array.
  const kept = record.network.slice(0, -1);
  for (let i = 0; i < kept.length; i++)
    expect(kept[i]).toEqual(network[i]);
  expect(kept.length + marker.omittedElements).toBe(network.length);
});

// Regression coverage for a container-collapse bug the truncation fix above
// introduced: MARKER_RESERVE_BYTES only reserves headroom for the marker
// itself, so a trimmed array can land right up against the 64 KB budget --
// an enclosing object with any sibling keys (script.sha256 alone is 76
// bytes) then pushed the WHOLE object over budget and hit the (unrelated,
// unchanged) object-collapse path, losing sha256/filename/args, not just
// over-trimming actions. Fixed by having an over-budget object shrink its
// array/object-valued ("compound") properties using whatever budget is left
// over after its non-shrinkable (scalar) properties, before ever collapsing
// itself -- see truncateOversizedObject in traceLog.ts.
test('an oversized nested array does not collapse its enclosing object: script.sha256/filename/args survive', async ({ mcpBrowser }, testInfo) => {
  test.skip(mcpBrowser !== 'chrome', 'Channel-agnostic; doesn\'t touch a browser at all.');
  const outputDir = testInfo.outputPath('output');
  const traceLog = await TraceLog.create(
      { outputDir },
      testInfo.outputPath(),
      { clientName: 'test', runtimeVersion: '0.0.0-test' },
  );
  // The re-reviewer's exact scenario: a script whose captured actions array
  // alone is comfortably over 64 KB, sitting alongside script's other,
  // individually-tiny keys.
  const actions = Array.from({ length: 3000 }, (_, i) => ({ apiName: 'locator.click', params: { i } }));
  expect(Buffer.byteLength(JSON.stringify(actions))).toBeGreaterThan(64 * 1024);
  const sha256 = 'a'.repeat(64);
  const args = { who: 'test' };

  traceLog.appendRecord({
    v: 1,
    seq: traceLog.nextSeq(),
    tool: 'browser_run_code_unsafe',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    params: { code: 'x' },
    targets: [],
    network: [],
    mutating: false,
    waits: { settleMs: 0, awaitedNavigation: false, awaitedRequests: 0 },
    code: [],
    script: { filename: 'foo.js', sha256, args, actions },
  });
  await traceLog.close();

  const lines = fs.readFileSync(path.join(traceLog.folder, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const record = lines[0];

  // Record identity core intact.
  expect(record.v).toBe(1);
  expect(record.tool).toBe('browser_run_code_unsafe');

  // script did NOT collapse to a bare { __truncated__, sizeBytes } marker --
  // its scalar/object siblings survive alongside the trimmed array.
  expect(record.script.sha256).toBe(sha256);
  expect(record.script.filename).toBe('foo.js');
  expect(record.script.args).toEqual(args);

  // script.actions stays a parseable array: real leading entries (in
  // original order) plus a trailing marker, not the whole array replaced.
  expect(Array.isArray(record.script.actions)).toBe(true);
  expect(record.script.actions.length).toBeGreaterThan(1);
  expect(record.script.actions.length).toBeLessThan(actions.length);
  const marker = record.script.actions[record.script.actions.length - 1];
  expect(marker.__truncated__).toBe(true);
  expect(typeof marker.omittedElements).toBe('number');
  expect(marker.omittedElements).toBeGreaterThan(0);
  // sizeBytes is the TRUE full array's size, not an already-trimmed
  // intermediate's -- this is what a naive "trim once at full budget, then
  // re-trim with a smaller budget" fix would get wrong.
  expect(marker.sizeBytes).toBe(Buffer.byteLength(JSON.stringify(actions)));
  const kept = record.script.actions.slice(0, -1);
  for (let i = 0; i < kept.length; i++)
    expect(kept[i]).toEqual(actions[i]);
  expect(kept.length + marker.omittedElements).toBe(actions.length);

  // The `script` field itself still honors the 64 KB single-value budget.
  expect(Buffer.byteLength(JSON.stringify(record.script))).toBeLessThanOrEqual(64 * 1024);
});

test('an oversized array in params does not collapse params: sibling keys survive', async ({ mcpBrowser }, testInfo) => {
  test.skip(mcpBrowser !== 'chrome', 'Channel-agnostic; doesn\'t touch a browser at all.');
  const outputDir = testInfo.outputPath('output');
  const traceLog = await TraceLog.create(
      { outputDir },
      testInfo.outputPath(),
      { clientName: 'test', runtimeVersion: '0.0.0-test' },
  );
  const items = Array.from({ length: 2000 }, (_, i) => ({ x: i, y: 'z'.repeat(30) }));
  expect(Buffer.byteLength(JSON.stringify(items))).toBeGreaterThan(64 * 1024);

  traceLog.appendRecord({
    v: 1,
    seq: traceLog.nextSeq(),
    tool: 'browser_run_code_unsafe',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    params: { code: 'some code', label: 'hello', items },
    targets: [],
    network: [],
    mutating: false,
    waits: { settleMs: 0, awaitedNavigation: false, awaitedRequests: 0 },
    code: [],
  });
  await traceLog.close();

  const lines = fs.readFileSync(path.join(traceLog.folder, 'actions.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  const record = lines[0];

  // params did NOT collapse -- its scalar sibling keys survive.
  expect(record.params.code).toBe('some code');
  expect(record.params.label).toBe('hello');
  expect(Array.isArray(record.params.items)).toBe(true);
  expect(record.params.items.length).toBeGreaterThan(1);
  expect(record.params.items.length).toBeLessThan(items.length);
  const marker = record.params.items[record.params.items.length - 1];
  expect(marker.__truncated__).toBe(true);
  expect(marker.omittedElements).toBeGreaterThan(0);
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
