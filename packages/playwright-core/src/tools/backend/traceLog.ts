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

export class TraceLog {
  readonly folder: string;
  private _stream: fs.WriteStream;
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
    this._stream = fs.createWriteStream(path.join(folder, 'actions.jsonl'), { flags: 'a' });
  }

  nextSeq(): number { return ++this._seq; }

  appendRecord(record: object): void {
    this._stream.write(JSON.stringify(record) + '\n');
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => this._stream.end(resolve));
  }
}
