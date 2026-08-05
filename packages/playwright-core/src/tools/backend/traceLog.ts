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
// before trimming, not of the marker or the kept prefix -- EXCEPT when this
// marker comes from scriptCapture.ts's MAX_CAPTURED_ACTIONS cap (a different
// producer of this same marker shape, upstream of and unrelated to this
// file's own truncation): there, entries past the cap were never retained in
// the first place, so `sizeBytes` is the serialized size of the kept
// (capped) entries instead -- there is no "full" array to honestly measure.
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

// Deep-walks a single record FIELD's value bottom-up against a byte
// `budget`, replacing any string leaf that's individually too large with
// `{ __truncated__: true, sizeBytes }`, trimming any oversized array to a
// fitting prefix plus a TraceTruncationMarker (see truncateArrayIfOversized
// below), and -- for a plain object -- collapsing it to a bare marker ONLY
// once it's confirmed there's no cheaper way to make it fit.
//
// That "confirmed" is the point of this function existing separately from a
// naive bottom-up collapse: an object whose own scalar keys are small but
// which also holds one oversized array- or object-valued key (e.g.
// `script`: {filename, sha256, args} alongside a huge `actions`) must not
// lose `sha256`/`filename`/`args` just because the object's *aggregate*
// size (dominated by `actions`) exceeds budget -- the fix is to shrink
// `actions` harder, using whatever budget the object has left over after
// its other keys, not to discard the whole object. Collapsing the whole
// object is the last resort: it happens only when the object's own
// non-shrinkable (scalar) content alone already exceeds budget, or when
// even every shrinkable child squeezed as far as its share of the leftover
// budget allows still doesn't leave enough room.
//
// Deliberately never called on the whole TraceRecord at once (see
// appendRecord below): the 64 KB rule is scoped to "any single record
// value," not to the record's aggregate size, so appendRecord invokes this
// once per top-level field (each with the full MAX_VALUE_BYTES budget)
// instead of once on `record` as a unit. That keeps identity fields (v,
// seq, tool, timestamps, urls, mutating, error) safe by construction --
// there is no code path where the record itself is treated as a
// collapsible leaf -- rather than by special-casing their key names.
// Nested containers (an object inside a field, an object inside an array
// element, ...) recurse into this same function at their own level, each
// applying the same "shrink my shrinkable children before collapsing
// myself" logic independently -- an oversized `script.args` gets its own
// chance to save itself via any array-valued key of its own, and the
// (now-appropriately-sized) result is treated as `script`'s fixed cost for
// deciding how much budget is left over for `script.actions`. This is what
// makes "args inside script inside record" -- an object-valued sibling
// that itself contains a large array, not just a large array directly --
// work correctly rather than only handling one level of nesting.
//
// `ancestors` guards against cycles: values are JSON-derived (parsed tool
// arguments, telemetry we built ourselves) so a cycle should never occur,
// but this call sits ahead of JSON.stringify inside appendRecord's own
// try/catch-less call site -- a throw here would silently lose the whole
// trace record, so the walk is made cycle-safe as cheap insurance rather
// than trusting that invariant. `value` stays registered in `ancestors` for
// this whole call (via try/finally, since an object can take two internal
// passes over its properties below) rather than being released as soon as
// the first pass finishes -- a self-reference reachable only from the
// second, budget-reduced pass must still be caught.
function truncateOversizedValues(value: unknown, budget: number, ancestors: Set<object> = new Set()): unknown {
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
  try {
    return Array.isArray(value)
      ? truncateOversizedArray(value, budget, ancestors)
      : truncateOversizedObject(value, budget, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function truncateOversizedArray(value: unknown[], budget: number, ancestors: Set<object>): unknown[] {
  // Elements are each individually walked at the standard full budget -- an
  // array's overall by-COUNT trim (governed by `budget`, which may be a
  // sibling-reduced budget passed down from an enclosing object) is a
  // separate concern from what any one kept element's own internal content
  // is allowed to occupy; every element still gets the same "any individual
  // record value" allowance regardless of how tight its array's own
  // count-budget ends up being.
  const elements = value.map(item => truncateOversizedValues(item, MAX_VALUE_BYTES, ancestors));
  return truncateArrayIfOversized(elements, budget);
}

function truncateOversizedObject(value: object, budget: number, ancestors: Set<object>): unknown {
  // Split properties into "fixed" (string/number/boolean/null -- resolved
  // once, and treated as a non-shrinkable cost from this object's point of
  // view) and "compound" (object- or array-valued -- shrinkable, and
  // deliberately given an optimistic first resolution at the FULL standard
  // budget rather than sharing this object's `budget` up front, so a small
  // object that easily fits doesn't get needlessly split down).
  const fixed: Record<string, unknown> = {};
  const compoundKeys: string[] = [];
  const compoundRaw = new Map<string, unknown>();
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && typeof v === 'object') {
      compoundKeys.push(k);
      compoundRaw.set(k, v);
    } else {
      fixed[k] = truncateOversizedValues(v, MAX_VALUE_BYTES, ancestors);
    }
  }
  const resolved: Record<string, unknown> = { ...fixed };
  for (const k of compoundKeys)
    resolved[k] = truncateOversizedValues(compoundRaw.get(k), MAX_VALUE_BYTES, ancestors);

  const size = safeSerializedByteLength(resolved);
  if (size === undefined || size <= budget)
    return resolved; // Fits as-is, every compound property at its natural size.
  if (compoundKeys.length === 0)
    return { __truncated__: true, sizeBytes: size };

  // Doesn't fit at natural size. Price the properties that truly can't
  // shrink -- the fixed ones, plus each compound property's key label,
  // represented here by a cheap `null` placeholder standing in for
  // "whatever this compound property eventually costs" -- to find out how
  // much budget is genuinely left over for the compound properties
  // combined. If even that skeleton doesn't fit, no amount of shrinking the
  // compound properties can save this object.
  const skeleton: Record<string, unknown> = { ...fixed };
  for (const k of compoundKeys)
    skeleton[k] = null;
  const skeletonSize = safeSerializedByteLength(skeleton);
  if (skeletonSize === undefined || skeletonSize > budget)
    return { __truncated__: true, sizeBytes: size };

  // Water-filling: give each compound property its full natural size when
  // that already fits within an equal share of what's left (smallest
  // natural size first), rather than shrinking every compound property to
  // an equal split regardless of need -- a `script.actions: []` sibling
  // shouldn't eat into the budget a genuinely oversized `script.args` needs
  // just because both happen to be "compound." Only re-resolved (from the
  // original raw value, at the reduced share) when the natural size doesn't
  // already fit -- re-resolving from raw, not from the already-computed
  // natural result, is what keeps any resulting marker's sizeBytes honest.
  let remainingBudget = budget - skeletonSize;
  let remainingCount = compoundKeys.length;
  const byNaturalSize = compoundKeys
      .map(k => ({ k, naturalSize: safeSerializedByteLength(resolved[k]) ?? 0 }))
      .sort((a, b) => a.naturalSize - b.naturalSize);
  for (const { k, naturalSize } of byNaturalSize) {
    const fairShare = Math.floor(remainingBudget / remainingCount);
    if (naturalSize > fairShare)
      resolved[k] = truncateOversizedValues(compoundRaw.get(k), fairShare, ancestors);
    remainingBudget -= Math.min(naturalSize, fairShare);
    remainingCount--;
  }

  const finalSize = safeSerializedByteLength(resolved);
  if (finalSize !== undefined && finalSize <= budget)
    return resolved;

  // Even every compound property shrunk as far as its share of the
  // remaining budget allows still doesn't fit (e.g. several compound
  // siblings splitting too small a remainder to hold even their own
  // markers) -- collapse as the last resort.
  return { __truncated__: true, sizeBytes: size };
}

// Reserved headroom subtracted from the byte budget so the trailing marker
// itself (plus the array's own `[`/`]`/comma punctuation) never pushes the
// final serialized array back over its budget. The marker serializes to
// well under 100 bytes for any realistic omittedElements/sizeBytes value;
// this is a generous, cheap-to-reason-about margin, not a tight fit.
const MARKER_RESERVE_BYTES = 128;

// Keeps the array's declared type intact even when oversized: walks the
// (already element-wise-truncated) array once, in order, accumulating a
// running byte total until the next element would exceed `budget`, then
// appends one TraceTruncationMarker summarizing everything past that point.
// `budget` is the standard MAX_VALUE_BYTES for a top-level field or a plain
// array-typed nested value, or a smaller, sibling-reduced share of it when
// called from an enclosing object's own truncateOversizedValues (see
// above) trying to save the rest of that object from collapsing. Single
// pass over precomputed per-element sizes -- deliberately not
// re-serializing the growing kept-so-far array on each iteration, which
// would make this O(n^2) for large arrays (e.g. a run_code script's capped
// but still up-to-10,000-element `actions` array).
function truncateArrayIfOversized(walked: unknown[], budget: number): unknown[] {
  const fullSize = safeSerializedByteLength(walked);
  if (fullSize === undefined || fullSize <= budget)
    return walked;

  const arrayBudget = budget - MARKER_RESERVE_BYTES;
  const kept: unknown[] = [];
  let runningBytes = 2; // '[' + ']'
  for (const item of walked) {
    const itemBytes = safeSerializedByteLength(item);
    if (itemBytes === undefined)
      break; // can't safely size this element (e.g. a surviving cycle guard); stop keeping here.
    const additional = itemBytes + (kept.length > 0 ? 1 : 0); // +1 for the separating comma
    if (runningBytes + additional > arrayBudget)
      break;
    runningBytes += additional;
    kept.push(item);
  }

  // `fullSize > budget > arrayBudget` (budget minus a positive reserve) is
  // exactly the guard above, so the running total -- which tracks fullSize
  // element-for-element -- is mathematically guaranteed to cross
  // `arrayBudget` before every element can be kept. omittedElements is
  // therefore always > 0 here; there is no "kept everything after all"
  // case to special-case.
  const omittedElements = walked.length - kept.length;
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
      safeRecord[key] = truncateOversizedValues(value, MAX_VALUE_BYTES);
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
