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
import { TraceLog, TRACE_SCHEMA_VERSION } from './traceLog';
import { packageJSON } from '../../package';
import type { ContextConfig } from './context';
import type * as playwright from '../../..';
import type { Tool } from './tool';
import type * as mcpServer from '../utils/mcp/server';
import type { ClientInfo, ServerBackend } from '../utils/mcp/server';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const READBACK_TOOLS = new Set([
  'browser_evaluate',
  'browser_run_code_unsafe',
  'browser_network_request',
  'browser_network_requests',
  'browser_take_screenshot',
  'browser_start_tracing',
  'browser_start_video',
  'browser_pdf_save',
  'browser_annotate',
]);

function isReadbackCall(name: string, args: Record<string, unknown>): boolean {
  if (READBACK_TOOLS.has(name))
    return true;
  if (name !== 'browser_navigate' || typeof args.url !== 'string')
    return false;
  try {
    return new URL(args.url).protocol === 'javascript:';
  } catch {
    return false;
  }
}

// A lost CDP connection is a different failure class from a tool call that
// simply did not work: a reconnected or replaced browser has no page state
// left, so an agent that retries the call that failed would run it against a
// blank browser and report confidently wrong evidence. Correct recovery is to
// restart from navigation, not to retry, so this needs to be distinguishable
// from an ordinary tool failure (a selector timeout, say) rather than folded
// into the same error shape.
//
// This signature set and the SIDECAR_LOST vocabulary mirror the fast-browser
// plugin's own flow-runner classifier (builtins/macros/flow-runner.js),
// which covers compiled flows; this closes the same gap for raw tool calls,
// which that classifier never sees. Verified against this fork's own
// TargetClosedError (packages/playwright-core/src/client/errors.ts), whose
// default message is exactly 'Target page, context or browser has been
// closed'. 'Browser has been disconnected' is kept even though it never
// originates in this repo's own source: it is the wording the fast-browser
// extension relay uses on its side of the sidecar, and a signature set that
// only matched this fork's half of the failure would defeat the point of
// keeping the two vocabularies consistent.
const CDP_DISCONNECT_SIGNATURES = [
  'Target closed',
  'Target crashed',
  'Target page, context or browser has been closed',
  'Browser has been closed',
  'Browser closed',
  'Browser has been disconnected',
  'WebSocket is not open',
  'WebSocket error',
  'Connection closed',
];

// Anchored to the message's first line only. Playwright's formatCallLog
// (client/connection.ts) appends a "locator resolved to <previewNode>" line
// to channel errors, and previewNode renders the target element's own
// attributes/text verbatim, so matching past the first line would let a page
// authoring a button labelled "Connection closed" forge a false positive. An
// ordinary selector timeout must stay an ordinary error.
function isCdpDisconnect(message: string): boolean {
  const firstLine = message.split('\n', 1)[0];
  return CDP_DISCONNECT_SIGNATURES.some(signature => firstLine.includes(signature));
}

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
      ? await TraceLog.create(this._config, clientInfo.cwd, {
        clientName: clientInfo.clientName,
        runtimeVersion: packageJSON.version,
        productVersion: this._config.productVersion,
        protocolVersion: this._config.protocolVersion,
      })
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
    // Named endpoints: which MCP tool was in flight (the call an agent must
    // not retry) and which page it was in flight against (urlBefore, below --
    // the last URL known good before all of its state was lost).
    //
    // Only the `SIDECAR_LOST: ` prefix and the recovery sentence are fixed;
    // `tool` is caller-supplied and `url`/`message` both carry page-influenced
    // text, exactly the text isCdpDisconnect refuses to match past the first
    // line of. That is safe here for a different reason than it is there:
    // JSON.stringify escapes what it embeds, so a page cannot close the object
    // early and forge a different shape for whoever parses this. It travels as
    // data inside the envelope, never as part of the envelope.
    const formatCdpDisconnect = (toolName: string, pageUrl: string | undefined, message: string): mcpServer.CallToolResult => {
      const shape = {
        tool: toolName,
        url: pageUrl,
        message,
        recovery: 'restart the flow from navigation; do not retry this call',
      };
      return formatError(`SIDECAR_LOST: ${JSON.stringify(shape)}`);
    };
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
    // Counted before the lock check so a fill that starts during the check still waits for this call to finish.
    // Nothing between here and the try below may throw, or the count never drains.
    const readback = isReadbackCall(name, parsedArguments);
    if (readback) {
      context.beginReadbackCall();
      let locked = true;
      try {
        locked = await context.isReadbackLocked();
      } finally {
        if (locked)
          context.endReadbackCall();
      }
      if (locked)
        return formatError(`${name} is unavailable until the page leaves the saved login it was just filled with.`);
    }
    context.setRunningTool(name);
    // Must run before tool.handle(): establishes this dispatch's epoch so any
    // action it starts (and any still-running background action from a prior,
    // modal-interrupted call) is unambiguous about which call it belongs to.
    // See the ActionTelemetry comment in context.ts for the race this guards.
    context.beginAction();
    const traceLog = this._traceLog;
    const startedAt = new Date().toISOString();
    const urlBefore = context.currentTab()?.page.url();
    let traceError: string | undefined;
    // Definite initializer only: the try/catch below always overwrites this
    // before it's read (success sets it via response.serialize(), any thrown
    // error sets it via formatError()) on every reachable path, including
    // the finally block's own read of responseObject.isError. Without an
    // initializer here, tsc's control-flow analysis can't prove that (a
    // finally block is conservatively treated as reachable even mid-catch,
    // before catch's own assignment runs), so this placeholder exists purely
    // to satisfy tsc — it is not expected to ever be the value actually read.
    let responseObject: mcpServer.CallToolResult & { isClose?: boolean } = formatError('Internal error: tool call produced no response');
    try {
      await tool.handle(context, parsedArguments, response, signal);
      for (const reason of context.drainPendingUnhandledRejections())
        response.addError(formatRejectionReason(reason));
      responseObject = await response.serialize();
      this._sessionLog?.logResponse(name, parsedArguments, responseObject, text => context.redactSecrets(text));
    } catch (error: any) {
      const messages = [String(error), ...context.drainPendingUnhandledRejections().map(formatRejectionReason)];
      traceError = context.redactSecrets(messages.join('\n\n'));
      responseObject = isCdpDisconnect(String(error))
        ? formatCdpDisconnect(name, urlBefore && context.redactSecrets(urlBefore), context.redactSecrets(String(error)))
        : formatError(traceError);
    } finally {
      if (readback)
        context.endReadbackCall();
      context.setRunningTool(undefined);
      // Tracing is a local side effect, not part of the tool-result contract: a
      // write failure (ENOSPC, EACCES, output dir removed mid-session, ...) must
      // never override an already-computed responseObject, so swallow-and-log.
      try {
        const telemetry = context.takeActionTelemetry();
        traceLog?.appendRecord({
          v: TRACE_SCHEMA_VERSION,
          seq: traceLog.nextSeq(),
          tool: name,
          startedAt,
          endedAt: new Date().toISOString(),
          params: parsedArguments,
          urlBefore,
          urlAfter: context.currentTab()?.page.url(),
          targets: telemetry.targets,
          network: telemetry.network,
          mutating: telemetry.network.some(n => !SAFE_METHODS.has(n.method.toUpperCase())),
          waits: telemetry.waits,
          code: response.code(),
          script: telemetry.script,
          error: traceError ?? (responseObject.isError ? extractErrorText(responseObject) : undefined),
        }, text => context.redactSecrets(text));
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
