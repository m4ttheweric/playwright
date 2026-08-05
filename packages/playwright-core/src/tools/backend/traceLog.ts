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
export type TraceRecord = {
  v: 1,
  seq: number,
  tool: string,
  startedAt: string,       // ISO-8601
  endedAt: string,
  params: unknown,         // parsed tool arguments, raw (trace is local-only)
  urlBefore?: string,
  urlAfter?: string,
  targets: TraceTarget[],
  network: TraceNetworkEntry[],
  mutating: boolean,       // any non-GET/HEAD/OPTIONS request in the action window
  waits: { settleMs: number, awaitedNavigation: boolean, awaitedRequests: number },
  code?: string[],         // generated Playwright code lines the Response collected
  script?: { filename?: string, sha256: string, args?: unknown, actions: TraceScriptAction[] },
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

// Deep-walks a record value bottom-up, replacing any string leaf -- or any
// object/array whose serialized size is still too large after its own
// children have been walked -- with `{ __truncated__: true, sizeBytes }`.
// Bottom-up (rather than checking each container's size before recursing)
// is what lets one oversized leaf (e.g. `script.args.big`) get replaced in
// place instead of the whole enclosing object being discarded.
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
  if (ancestors.has(value))
    return { __truncated__: true, sizeBytes: 0 };

  ancestors.add(value);
  const walked: unknown = Array.isArray(value)
    ? value.map(item => truncateOversizedValues(item, ancestors))
    : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateOversizedValues(v, ancestors)]));
  ancestors.delete(value);

  const size = safeSerializedByteLength(walked);
  if (size !== undefined && size > MAX_VALUE_BYTES)
    return { __truncated__: true, sizeBytes: size };
  return walked;
}

export class TraceLog {
  readonly folder: string;
  private _actionsFile: string;
  private _seq = 0;

  static async create(config: ContextConfig, cwd: string, info: { clientName: string, runtimeVersion: string }): Promise<TraceLog> {
    const folder = await outputFile({ config, cwd }, `trace-${Date.now()}`, { origin: 'code' });
    await fs.promises.mkdir(folder, { recursive: true });
    await fs.promises.writeFile(path.join(folder, 'meta.json'), JSON.stringify({
      schemaVersion: 1,
      clientName: info.clientName,
      cwd,
      runtimeVersion: info.runtimeVersion,
      protocolVersion: 2,
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
    const safeRecord = truncateOversizedValues(record);
    fs.appendFileSync(this._actionsFile, JSON.stringify(safeRecord) + '\n');
  }

  async close(): Promise<void> {
    const metaPath = path.join(this.folder, 'meta.json');
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'));
    meta.endedAt = new Date().toISOString();
    await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));
  }
}
