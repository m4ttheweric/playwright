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
  // with no await required at the call site.
  appendRecord(record: TraceRecord): void {
    fs.appendFileSync(this._actionsFile, JSON.stringify(record) + '\n');
  }

  async close(): Promise<void> {
  }
}
