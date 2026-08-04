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

import * as z from 'zod';
import debug from 'debug';
import { Context } from './context';
import { Response } from './response';
import { SessionLog } from './sessionLog';
import { TraceLog } from './traceLog';
import { packageJSON } from '../../package';
import type { ContextConfig } from './context';
import type * as playwright from '../../..';
import type { Tool } from './tool';
import type * as mcpServer from '../utils/mcp/server';
import type { ClientInfo, ServerBackend } from '../utils/mcp/server';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class BrowserBackend implements ServerBackend {
  private _tools: Tool[];
  private _context: Context | undefined;
  private _sessionLog: SessionLog | undefined;
  private _traceLog: TraceLog | undefined;
  private _config: ContextConfig;
  private _disconnected = false;
  readonly browserContext: playwright.BrowserContext;

  constructor(config: ContextConfig, browserContext: playwright.BrowserContext, tools: Tool[]) {
    this._config = config;
    this._tools = tools;
    this.browserContext = browserContext;
    const markDisconnected = () => { this._disconnected = true; };
    this.browserContext.once('close', markDisconnected);
    this.browserContext.browser()?.once('disconnected', markDisconnected);
  }

  async initialize(clientInfo: ClientInfo): Promise<void> {
    this._sessionLog = this._config.saveSession ? await SessionLog.create(this._config, clientInfo.cwd) : undefined;
    this._traceLog = this._config.saveTrace
      ? await TraceLog.create(this._config, clientInfo.cwd, { clientName: clientInfo.clientName, runtimeVersion: packageJSON.version })
      : undefined;
    this._context = new Context(this.browserContext, {
      config: this._config,
      sessionLog: this._sessionLog,
      traceLog: this._traceLog,
      cwd: clientInfo.cwd,
    });
  }

  async dispose() {
    await this._context?.dispose().catch(e => debug('pw:tools:error')(e));
    await this._traceLog?.close().catch(e => debug('pw:tools:error')(e));
  }

  async callTool(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments'] & { _meta?: Record<string, any> } = {}, signal?: AbortSignal): Promise<mcpServer.CallToolResult & { isClose?: boolean }> {
    const json = !!rawArguments._meta?.json;
    const formatError = (message: string): mcpServer.CallToolResult => ({
      content: [{ type: 'text' as const, text: json ? JSON.stringify({ isError: true, error: message }, null, 2) : `### Error\n${message}` }],
      isError: true,
    });
    const tool = this._tools.find(tool => tool.schema.name === name)!;
    if (!tool)
      return formatError(`Tool "${name}" not found`);
    let parsedArguments: any;
    try {
      parsedArguments = tool.schema.inputSchema.parse(rawArguments);
    } catch (error) {
      if (error instanceof z.ZodError)
        return formatError(`Invalid arguments for tool "${name}":\n${z.prettifyError(error)}`);
      throw error;
    }
    const cwd = rawArguments._meta?.cwd;
    const raw = !!rawArguments._meta?.raw;
    const context = this._context!;
    const response = new Response(context, name, parsedArguments, { relativeTo: cwd, raw, json });
    context.setRunningTool(name);
    const traceLog = this._traceLog;
    const startedAt = new Date().toISOString();
    const urlBefore = context.currentTab()?.page.url();
    let traceError: string | undefined;
    let responseObject: mcpServer.CallToolResult & { isClose?: boolean };
    try {
      await tool.handle(context, parsedArguments, response, signal);
      for (const reason of context.drainPendingUnhandledRejections())
        response.addError(formatRejectionReason(reason));
      responseObject = await response.serialize();
      this._sessionLog?.logResponse(name, parsedArguments, responseObject);
    } catch (error: any) {
      const messages = [String(error), ...context.drainPendingUnhandledRejections().map(formatRejectionReason)];
      traceError = messages.join('\n\n');
      responseObject = formatError(traceError);
    } finally {
      context.setRunningTool(undefined);
      // Tracing is a local side effect, not part of the tool-result contract: a
      // write failure (ENOSPC, EACCES, output dir removed mid-session, ...) must
      // never override an already-computed responseObject, so swallow-and-log.
      try {
        const telemetry = context.takeActionTelemetry();
        const network = telemetry?.network ?? [];
        traceLog?.appendRecord({
          v: 1,
          seq: traceLog.nextSeq(),
          tool: name,
          startedAt,
          endedAt: new Date().toISOString(),
          params: parsedArguments,
          urlBefore,
          urlAfter: context.currentTab()?.page.url(),
          targets: [],
          network,
          mutating: network.some(n => !SAFE_METHODS.has(n.method.toUpperCase())),
          waits: telemetry?.waits ?? { settleMs: 0, awaitedNavigation: false, awaitedRequests: 0 },
          code: response.code(),
          error: traceError ?? (responseObject.isError ? extractErrorText(responseObject) : undefined),
        });
      } catch (e) {
        debug('pw:tools:error')(e);
      }
    }
    if (this._disconnected)
      responseObject.isClose = true;
    return responseObject;
  }
}

function extractErrorText(responseObject: mcpServer.CallToolResult): string | undefined {
  const content = responseObject.content[0];
  return content?.type === 'text' ? content.text : undefined;
}

function formatRejectionReason(reason: unknown): string {
  if (reason instanceof Error)
    return reason.stack ?? reason.message;
  return String(reason);
}
