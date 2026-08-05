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

import { outputFile } from './context';

import type { ContextConfig } from './context';

export type TraceLocator = { kind: 'role' | 'testid' | 'text' | 'css' | 'other', selector: string };
export type TraceTarget = {
  ref?: string;            // aria ref (e.g. 'e12') when the call used one
  resolved?: string;       // human-readable locator from targetLocators/normalize
  alternates: TraceLocator[];
  role?: string;
  name?: string;
  description?: string;    // accessible description, else accessible name
};
// Classifies a `Locator._selectorCandidates()` candidate string by its engine
// prefix. Candidates are ordered best-first from `generateSelector`; most are
// `internal:<engine>=...` (or, for a couple of legacy engines, `<engine>=...`
// with no `internal:` marker). A candidate with no recognized engine prefix
// at all is a bare CSS selector (e.g. `#save-btn`, `span`) -- `generateSelector`
// never prefixes its plain-CSS fallback with `css=`, so "no prefix" must map
// to `css`, not `other`. Engines outside the four kinds this trace format
// tracks (e.g. `internal:label`, `internal:attr`) fall through to `other`.
export function traceLocatorKind(candidate: string): TraceLocator['kind'] {
  const engine = /^(?:internal:)?([a-zA-Z-]+)=/.exec(candidate)?.[1];
  switch (engine) {
    case 'role': return 'role';
    case 'testid': return 'testid';
    case 'text': return 'text';
    case 'css': return 'css';
    default: return engine ? 'other' : 'css';
  }
}

export type TraceNetworkEntry = { method: string, url: string, resourceType: string, status?: number, failed?: boolean };
export type TraceScriptAction = { apiName: string, params?: unknown, error?: string };

// Appended as the final element of a truncated array field in place of
// collapsing the whole array to a bare marker object (see
// truncateArrayIfOversized below) -- this is what lets `network`, `targets`,
// `code`, and `script.actions` keep their declared array type even when
// oversized, which is load-bearing for WS2 (the downstream compiler reads
// these fields expecting an array, never a bare object). `omittedElements`
// counts entries dropped from the END of the array (kept elements are always
// a prefix); `sizeBytes` is the post-walk serialized size of the FULL array
// before trimming, not of the marker or the kept prefix.
export type TraceTruncationMarker = { __truncated__: true, omittedElements: number, sizeBytes: number };

// This trace format's schema version. Used for both meta.json's
// `schemaVersion` and every record's `v` -- the two are the same number by
// design (meta.json's own comment on this documents why: a record is
// self-describing even read out of context of its meta.json). Bump this,
// not the two call sites, when the schema changes.
export const TRACE_SCHEMA_VERSION = 1;

export type TraceRecord = {
  v: typeof TRACE_SCHEMA_VERSION,
  seq: number,
  tool: string,
  startedAt: string,       // ISO-8601
  endedAt: string,
  params: unknown,         // parsed tool arguments, raw (trace is local-only)
  urlBefore?: string,
  urlAfter?: string,
  targets: (TraceTarget | TraceTruncationMarker)[],
  network: (TraceNetworkEntry | TraceTruncationMarker)[],
  mutating: boolean,       // any non-GET/HEAD/OPTIONS request in the action window
  waits: { settleMs: number, awaitedNavigation: boolean, awaitedRequests: number },
  code: (string | TraceTruncationMarker)[], // generated Playwright code lines the Response collected; [] minimum, never absent
  script?: { filename?: string, sha256: string, args?: unknown, actions: (TraceScriptAction | TraceTruncationMarker)[] },
  error?: string,
};

// Any single record value whose serialized size exceeds this is replaced by
// a truncation marker before the record is written -- snapshot-sized payloads
// (e.g. a screenshot or large blob passed as a run_code arg) must not bloat
// the trace on disk.
const MAX_VALUE_BYTES = 64 * 1024;

// Returns the byte length of `value` serialized as JSON, or undefined if it
// can't be serialized (e.g. contains a cycle that survived the ancestor
// guard, a BigInt, ...). Never throws.
function safeSerializedByteLength(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : Buffer.byteLength(json);
  } catch {
    return undefined;
  }
}

// Deep-walks a single record FIELD's value bottom-up, replacing any string
// leaf -- or any object/array whose serialized size is still too large after
// its own children have been walked -- with `{ __truncated__: true,
// sizeBytes }`. Bottom-up (rather than checking each container's size before
// recursing) is what lets one oversized leaf (e.g. `script.args.big`) get
// replaced in place instead of the whole enclosing object being discarded.
//
// Deliberately never called on the whole TraceRecord at once (see
// appendRecord below): the 64 KB rule is scoped to "any single record
// value," not to the record's aggregate size, so appendRecord invokes this
// once per top-level field instead of once on `record` as a unit. That keeps
// identity fields (v, seq, tool, timestamps, urls, mutating, error) safe by
// construction -- there is no code path where the record itself is treated
// as a collapsible leaf -- rather than by special-casing their key names.
//
// `ancestors` guards against cycles: values are JSON-derived (parsed tool
// arguments, telemetry we built ourselves) so a cycle should never occur,
// but this call sits ahead of JSON.stringify inside appendRecord's own
// try/catch-less call site -- a throw here would silently lose the whole
// trace record, so the walk is made cycle-safe as cheap insurance rather
// than trusting that invariant.
function truncateOversizedValues(value: unknown, ancestors: Set<object> = new Set()): unknown {
  if (typeof value === 'string') {
    const size = Buffer.byteLength(value);
    return size > MAX_VALUE_BYTES ? { __truncated__: true, sizeBytes: size } : value;
  }
  if (value === null || typeof value !== 'object')
    return value;
  // A cycle has no honest sizeBytes to report without re-serializing (which
  // is exactly what would throw), so the field is omitted rather than
  // fabricated -- values are JSON-derived and shouldn't cycle in practice,
  // this is cheap insurance, not a path expected to fire.
  if (ancestors.has(value))
    return { __truncated__: true };

  ancestors.add(value);
  const walked: unknown = Array.isArray(value)
    ? value.map(item => truncateOversizedValues(item, ancestors))
    : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateOversizedValues(v, ancestors)]));
  ancestors.delete(value);

  // Arrays never collapse to a bare marker object -- that would break the
  // declared array type of every array-shaped TraceRecord field (`network`,
  // `targets`, `code`, `script.actions`), which WS2 codes against expecting
  // an array, never an object. Object (non-array) containers keep the
  // original collapse-to-marker behavior below.
  if (Array.isArray(walked))
    return truncateArrayIfOversized(walked);

  const size = safeSerializedByteLength(walked);
  if (size !== undefined && size > MAX_VALUE_BYTES)
    return { __truncated__: true, sizeBytes: size };
  return walked;
}

// Reserved headroom subtracted from the byte budget so the trailing marker
// itself (plus the array's own `[`/`]`/comma punctuation) never pushes the
// final serialized array back over MAX_VALUE_BYTES. The marker serializes to
// well under 100 bytes for any realistic omittedElements/sizeBytes value;
// this is a generous, cheap-to-reason-about margin, not a tight fit.
const MARKER_RESERVE_BYTES = 128;

// Keeps the array's declared type intact even when oversized: walks the
// (already element-wise-truncated) array once, in order, accumulating a
// running byte total until the next element would exceed the budget, then
// appends one TraceTruncationMarker summarizing everything past that point.
// Single pass over precomputed per-element sizes -- deliberately not
// re-serializing the growing kept-so-far array on each iteration, which
// would make this O(n^2) for large arrays (e.g. a run_code script's capped
// but still up-to-10,000-element `actions` array).
function truncateArrayIfOversized(walked: unknown[]): unknown[] {
  const fullSize = safeSerializedByteLength(walked);
  if (fullSize === undefined || fullSize <= MAX_VALUE_BYTES)
    return walked;

  const budget = MAX_VALUE_BYTES - MARKER_RESERVE_BYTES;
  const kept: unknown[] = [];
  let runningBytes = 2; // '[' + ']'
  for (const item of walked) {
    const itemBytes = safeSerializedByteLength(item);
    if (itemBytes === undefined)
      break; // can't safely size this element (e.g. a surviving cycle guard); stop keeping here.
    const additional = itemBytes + (kept.length > 0 ? 1 : 0); // +1 for the separating comma
    if (runningBytes + additional > budget)
      break;
    runningBytes += additional;
    kept.push(item);
  }

  const omittedElements = walked.length - kept.length;
  if (omittedElements === 0)
    return kept;
  const marker: TraceTruncationMarker = { __truncated__: true, omittedElements, sizeBytes: fullSize };
  return [...kept, marker];
}

export class TraceLog {
  readonly folder: string;
  private _actionsFile: string;
  private _seq = 0;
  private _closed = false;

  // `productVersion`/`protocolVersion` are threaded in as plain data rather
  // than imported: this backend cannot import from `src/tools/mcp/` (see
  // DEPS.list), which is where the real product version (mcp/program.ts's
  // `serverVersion`) and the real `VERSION` (mcp/protocol.ts) live. Callers
  // outside backend/ read those and pass them down here.
  static async create(config: ContextConfig, cwd: string, info: { clientName: string, runtimeVersion: string, productVersion?: string, protocolVersion?: number }): Promise<TraceLog> {
    const folder = await outputFile({ config, cwd }, `trace-${Date.now()}`, { origin: 'code' });
    await fs.promises.mkdir(folder, { recursive: true });
    await fs.promises.writeFile(path.join(folder, 'meta.json'), JSON.stringify({
      schemaVersion: TRACE_SCHEMA_VERSION,
      clientName: info.clientName,
      cwd,
      runtimeVersion: info.runtimeVersion,
      productVersion: info.productVersion,
      protocolVersion: info.protocolVersion,
      startedAt: new Date().toISOString(),
    }, null, 2));
    return new TraceLog(folder);
  }

  private constructor(folder: string) {
    this.folder = folder;
    this._actionsFile = path.join(folder, 'actions.jsonl');
    fs.writeFileSync(this._actionsFile, '');
  }

  nextSeq(): number { return ++this._seq; }

  // Synchronous by design: the caller (the dispatch seam in browserBackend's
  // callTool) needs the record durable on disk before the tool call returns,
  // with no await required at the call site. appendFileSync also means there
  // is no internal buffering to lose on a hard kill: the line is durable the
  // moment this call returns.
  appendRecord(record: TraceRecord): void {
    // Walk each top-level field independently rather than handing the whole
    // record to truncateOversizedValues in one call. The 64 KB rule is about
    // any single VALUE inside a record, never the record itself: a busy
    // action can easily have several individually-small fields (many small
    // network entries, a long code[] array, ...) that only look oversized in
    // aggregate, and the record's identity fields (v, seq, tool, timestamps,
    // urls, mutating, error) must survive regardless. Walking field-by-field
    // means the whole-record aggregate size is never computed or acted on --
    // only a genuinely oversized individual field can ever collapse, and it
    // collapses alone, leaving its siblings (and the record shape) intact.
    const safeRecord: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record))
      safeRecord[key] = truncateOversizedValues(value);
    fs.appendFileSync(this._actionsFile, JSON.stringify(safeRecord) + '\n');
  }

  async close(): Promise<void> {
    if (this._closed)
      return;
    this._closed = true;
    const metaPath = path.join(this.folder, 'meta.json');
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'));
    meta.endedAt = new Date().toISOString();
    await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));
  }
}
