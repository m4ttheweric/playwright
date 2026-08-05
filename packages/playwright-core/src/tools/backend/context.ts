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
import os from 'os';
import path from 'path';

import debug from 'debug';
import { escapeWithQuotes } from '@isomorphic/stringUtils';
import { disposeAll } from '@isomorphic/disposable';
import { eventsHelper } from '@utils/eventsHelper';
import { isPathInside, isSystemDirectory, isWritable } from '@utils/fileUtils';
import { playwright } from '../../inprocess';

import { Tab } from './tab';

import type * as playwrightTypes from '../../..';
import type { SessionLog } from './sessionLog';
import type { TraceLog, TraceNetworkEntry, TraceRecord, TraceTarget } from './traceLog';
import type { Disposable } from '@isomorphic/disposable';
import type { ToolCapability } from './tool';

const testDebug = debug('pw:mcp:test');

export type ContextConfig = {
  allowUnrestrictedFileAccess?: boolean;
  capabilities?: ToolCapability[];
  codegen?: 'typescript' | 'none';
  console?: { level?: 'error' | 'warning' | 'info' | 'debug' };
  imageResponses?: 'allow' | 'omit';
  network?: {
    allowedOrigins?: string[];
    blockedOrigins?: string[];
  };
  outputDir?: string;
  outputMaxSize?: number;
  saveSession?: boolean;
  saveTrace?: boolean;
  // Not CLI-settable: threaded in by the caller that constructs BrowserBackend
  // (mcp/program.ts and friends) from data those callers already have --
  // mcp/program.ts's `serverVersion` and mcp/protocol.ts's `VERSION` -- and
  // read back out in TraceLog.create() to populate meta.json. Exist on
  // ContextConfig rather than being imported directly into traceLog.ts
  // because backend/ cannot import from mcp/ (see DEPS.list).
  productVersion?: string;
  protocolVersion?: number;
  secrets?: Record<string, string>;
  snapshot?: {
    mode?: 'full' | 'none';
  };
  testIdAttribute?: string;
  timeouts?: {
    action?: number;
    navigation?: number;
    expect?: number;
    settle?: number;
  };
  browser?: {
    initScript?: string[];
    initPage?: string[];
  };
  skillMode?: boolean;
};

type ContextOptions = {
  config: ContextConfig;
  sessionLog?: SessionLog;
  traceLog?: TraceLog;
  cwd: string;
};

export type RouteEntry = {
  pattern: string;
  status?: number;
  body?: string;
  contentType?: string;
  addHeaders?: Record<string, string>;
  removeHeaders?: string[];
  handler: (route: playwrightTypes.Route) => Promise<void>;
};

export type FilenameTemplate = {
  prefix: string;
  ext: string;
  suggestedFilename?: string;
  date?: Date;
};

type VideoParams = { size?: { width: number; height: number } };

// Per-action telemetry collected while a tool's own callback runs (network
// activity, waits). A take-once accessor: set during the action by
// waitForCompletion, drained exactly once by the dispatch seam in
// BrowserBackend.callTool, and cleared on take so a telemetry-less tool
// (e.g. browser_snapshot, which never calls waitForCompletion) records empty
// network rather than the previous action's stale data.
//
// Epoch-guarded because take-once alone is not enough: Tab._raceAgainstModalStates
// races an action against a modal-state event (e.g. a dialog opened mid-click).
// When the modal wins, Tab.waitForCompletion returns early while the action's
// own waitForCompletion() keeps running in the background — it can only finish
// once the dialog is handled by a *later* tool call, at which point calling
// setActionTelemetry unconditionally would stamp the interrupted action's data
// onto whatever call happens to be current. Each dispatched tool call owns an
// epoch (bumped in beginAction, called before the tool runs); a telemetry write
// tagged with a stale epoch is silently dropped instead of corrupting the next
// trace record.
// The network/waits half of an action's telemetry, produced by
// waitForCompletion() once the action settles. Not every action tool calls
// waitForCompletion (e.g. browser_hover, browser_select_option resolve their
// target and act directly) -- setActionTelemetry is simply never called for
// those, and takeActionTelemetry() below falls back to empty/zeroed values.
export type ActionNetworkTelemetry = {
  network: TraceNetworkEntry[];
  waits: TraceRecord['waits'];
};

// Everything the dispatch seam in BrowserBackend.callTool needs to fill in a
// TraceRecord, drained once per call by takeActionTelemetry().
export type ActionTelemetry = ActionNetworkTelemetry & {
  targets: TraceTarget[];
  script?: TraceRecord['script'];
};

// Fresh object per call -- TraceRecord.waits ends up serialized independently
// per trace line, so nothing is gained (and an aliasing hazard is risked) by
// sharing one instance across calls.
function zeroWaits(): ActionNetworkTelemetry['waits'] {
  return { settleMs: 0, awaitedNavigation: false, awaitedRequests: 0 };
}

export class Context {
  readonly config: ContextConfig;
  readonly sessionLog: SessionLog | undefined;
  readonly traceLog: TraceLog | undefined;
  readonly options: ContextOptions;
  private _rawBrowserContext: playwrightTypes.BrowserContext;
  private _browserContextPromise: Promise<playwrightTypes.BrowserContext> | undefined;
  private _tabs: Tab[] = [];
  private _currentTab: Tab | undefined;
  private _routes: RouteEntry[] = [];
  private _video: {
    params: VideoParams;
    fileNames: string[];
    fileName: string;
  } | undefined;
  private _disposables: Disposable[] = [];

  private _runningToolName: string | undefined;
  private _actionEpoch = 0;
  private _actionTelemetry: ActionNetworkTelemetry | undefined;
  // Separate from _actionTelemetry (and not folded into one object with it)
  // because target enrichment happens earlier in a tool's handle() -- while
  // resolving the locator, before the action itself runs -- than
  // setActionTelemetry, which only fires once waitForCompletion's action
  // settles (and some tools, e.g. browser_hover, never call it at all). Two
  // independent take-once slots, both gated by the same epoch, avoids having
  // to merge into a possibly-not-yet-created telemetry object from whichever
  // of the two writers happens to run first.
  private _actionTargets: TraceTarget[] = [];
  // Set by browser_run_code_unsafe's handler once its vm run settles (success
  // or failure); undefined for every other tool. Same take-once/epoch
  // discipline as _actionTelemetry/_actionTargets and for the same reason:
  // runCode.ts's vm run is itself awaited inside waitForCompletion, so it
  // cannot race a later call the way a modal-interrupted action can, but
  // reusing the mechanism keeps the drain in takeActionTelemetry() uniform.
  private _scriptTelemetry: TraceRecord['script'] | undefined;
  private _pendingUnhandledRejections: unknown[] = [];
  private _unhandledRejectionListeners = new Set<(reason: unknown) => void>();
  private _onUnhandledRejection = (reason: unknown) => {
    this._pendingUnhandledRejections.push(reason);
    for (const listener of this._unhandledRejectionListeners)
      listener(reason);
  };

  constructor(browserContext: playwrightTypes.BrowserContext, options: ContextOptions) {
    this.config = options.config;
    this.sessionLog = options.sessionLog;
    this.traceLog = options.traceLog;
    this.options = options;
    this._rawBrowserContext = browserContext;
    testDebug('create context');
    process.on('unhandledRejection', this._onUnhandledRejection);
  }

  async dispose() {
    process.off('unhandledRejection', this._onUnhandledRejection);
    await disposeAll(this._disposables);
    for (const tab of this._tabs)
      await tab.dispose();
    this._tabs.length = 0;
    this._currentTab = undefined;
    await this.stopVideoRecording();
  }

  drainPendingUnhandledRejections(): unknown[] {
    const reasons = this._pendingUnhandledRejections.slice();
    this._pendingUnhandledRejections.length = 0;
    return reasons;
  }

  onUnhandledRejection(listener: (reason: unknown) => void): () => void {
    this._unhandledRejectionListeners.add(listener);
    return () => this._unhandledRejectionListeners.delete(listener);
  }

  debugger() {
    return this._rawBrowserContext.debugger;
  }

  tabs(): Tab[] {
    return this._tabs;
  }

  currentTab(): Tab | undefined {
    return this._currentTab;
  }

  currentTabOrDie(): Tab {
    if (!this._currentTab)
      throw new Error('No open pages available.');
    return this._currentTab;
  }

  async newTab(): Promise<Tab> {
    const browserContext = await this.ensureBrowserContext();
    const page = await browserContext.newPage();
    this._currentTab = this._tabs.find(t => t.page === page)!;
    return this._currentTab;
  }

  async selectTab(index: number) {
    const tab = this._tabs[index];
    if (!tab)
      throw new Error(`Tab ${index} not found`);
    await tab.page.bringToFront();
    this._currentTab = tab;
    return tab;
  }

  async ensureTab(): Promise<Tab> {
    await this.ensureBrowserContext();
    const crashed = this._currentTab?.crashed;
    if (crashed) {
      await this._currentTab!.page.close().catch(() => {});
      this._currentTab = undefined;
    }
    if (!this._currentTab)
      await this.newTab();
    if (crashed)
      this._currentTab!.logErrorMessage('Page crashed and was reset to about:blank.');
    await this._currentTab!.waitForInitialized();
    return this._currentTab!;
  }

  async closeTab(index: number | undefined): Promise<string> {
    const tab = index === undefined ? this._currentTab : this._tabs[index];
    if (!tab)
      throw new Error(`Tab ${index} not found`);
    const url = tab.page.url();
    await tab.page.close();
    return url;
  }

  async workspaceFile(fileName: string, perCallWorkspaceDir: string | undefined): Promise<string> {
    return await workspaceFile(this.options, fileName, perCallWorkspaceDir);
  }

  async outputFile(template: FilenameTemplate, options: { origin: 'code' | 'llm' }): Promise<string> {
    const baseName = template.suggestedFilename || `${template.prefix}-${(template.date ?? new Date()).toISOString().replace(/[:.]/g, '-')}${template.ext ? '.' + template.ext : ''}`;
    return await outputFile(this.options, baseName, options);
  }

  async startVideoRecording(fileName: string, params: VideoParams) {
    if (this._video)
      throw new Error('Video recording has already been started.');
    this._video = { params, fileName, fileNames: [] };
    const browserContext = await this.ensureBrowserContext();
    for (const page of browserContext.pages())
      await this._startPageVideo(page);
  }

  async stopVideoRecording(): Promise<string[]> {
    if (!this._video)
      return [];
    const video = this._video;
    for (const page of this._rawBrowserContext.pages())
      await page.screencast.stop();
    this._video = undefined;
    return [...video.fileNames];
  }

  private async _startPageVideo(page: playwrightTypes.Page) {
    if (!this._video)
      return;
    const suffix = this._video.fileNames.length ? `-${this._video.fileNames.length}` : '';
    let fileName = this._video.fileName;
    if (fileName && suffix) {
      const dir = path.dirname(fileName);
      const ext = path.extname(fileName);
      fileName = path.join(dir, path.basename(fileName, ext) + suffix + ext);
    }
    this._video.fileNames.push(fileName);
    await page.screencast.start({ path: fileName, ...this._video.params });
  }

  private _onPageCreated(page: playwrightTypes.Page) {
    const tab = new Tab(this, page, tab => this._onPageClosed(tab));
    this._tabs.push(tab);
    if (!this._currentTab)
      this._currentTab = tab;
    this._startPageVideo(page).catch(() => {});
  }

  private _onPageClosed(tab: Tab) {
    const index = this._tabs.indexOf(tab);
    if (index === -1)
      return;
    this._tabs.splice(index, 1);

    if (this._currentTab === tab)
      this._currentTab = this._tabs[Math.min(index, this._tabs.length - 1)];
  }

  routes(): RouteEntry[] {
    return this._routes;
  }

  async addRoute(entry: RouteEntry): Promise<void> {
    const browserContext = await this.ensureBrowserContext();
    await browserContext.route(entry.pattern, entry.handler);
    this._routes.push(entry);
  }

  async removeRoute(pattern?: string): Promise<number> {
    let removed = 0;
    const browserContext = await this.ensureBrowserContext();
    if (pattern) {
      const toRemove = this._routes.filter(r => r.pattern === pattern);
      for (const route of toRemove)
        await browserContext.unroute(route.pattern, route.handler);
      this._routes = this._routes.filter(r => r.pattern !== pattern);
      removed = toRemove.length;
    } else {
      for (const route of this._routes)
        await browserContext.unroute(route.pattern, route.handler);
      removed = this._routes.length;
      this._routes = [];
    }
    return removed;
  }

  isRunningTool() {
    return this._runningToolName !== undefined;
  }

  setRunningTool(name: string | undefined) {
    this._runningToolName = name;
  }

  // Marks the start of a newly dispatched tool call: bumps the action epoch
  // and drops any telemetry still sitting from a previous call (including a
  // stale write that lands between calls — see the ActionTelemetry comment).
  // Must run before the tool's own handle() so any action it starts is
  // stamped with this call's epoch, not a leftover one.
  beginAction(): number {
    this._actionEpoch++;
    this._actionTelemetry = undefined;
    this._actionTargets = [];
    this._scriptTelemetry = undefined;
    return this._actionEpoch;
  }

  currentActionEpoch(): number {
    return this._actionEpoch;
  }

  // Stores telemetry for the action tagged with `epoch`. A mismatched epoch
  // means the action that produced this data was superseded by a later tool
  // call (see ActionTelemetry) while it kept running in the background; the
  // write is dropped rather than corrupting the current call's trace record.
  setActionTelemetry(epoch: number, telemetry: ActionNetworkTelemetry) {
    if (epoch !== this._actionEpoch)
      return;
    this._actionTelemetry = telemetry;
  }

  // Records one enriched target for the action tagged with `epoch`, called
  // while a ref-based action tool (click/type/hover/select_option/drag)
  // resolves its locator(s) in Tab.targetLocators. Same epoch discipline as
  // setActionTelemetry and for the same reason: a target resolved by an
  // action that a later tool call has since superseded must not attach
  // itself to that later call's trace record.
  addActionTarget(epoch: number, target: TraceTarget) {
    if (epoch !== this._actionEpoch)
      return;
    this._actionTargets.push(target);
  }

  // Stores script telemetry (source hash, args, captured API actions) for the
  // browser_run_code_unsafe call tagged with `epoch`. Same epoch discipline
  // as setActionTelemetry/addActionTarget: a write tagged with a stale epoch
  // is dropped rather than attaching to a later call's trace record.
  setScriptTelemetry(epoch: number, script: TraceRecord['script']) {
    if (epoch !== this._actionEpoch)
      return;
    this._scriptTelemetry = script;
  }

  takeActionTelemetry(): ActionTelemetry {
    const telemetry = this._actionTelemetry;
    const targets = this._actionTargets;
    const script = this._scriptTelemetry;
    this._actionTelemetry = undefined;
    this._actionTargets = [];
    this._scriptTelemetry = undefined;
    return {
      network: telemetry?.network ?? [],
      waits: telemetry?.waits ?? zeroWaits(),
      targets,
      script,
    };
  }

  private async _setupRequestInterception(context: playwrightTypes.BrowserContext) {
    if (this.config.network?.allowedOrigins?.length) {
      this._disposables.push(await context.route('**', route => route.abort('blockedbyclient')));

      for (const origin of this.config.network.allowedOrigins) {
        const glob = originOrHostGlob(origin);
        this._disposables.push(await context.route(glob, route => route.continue()));
      }
    }

    if (this.config.network?.blockedOrigins?.length) {
      for (const origin of this.config.network.blockedOrigins)
        this._disposables.push(await context.route(originOrHostGlob(origin), route => route.abort('blockedbyclient')));
    }
  }

  async ensureBrowserContext(): Promise<playwrightTypes.BrowserContext> {
    if (this._browserContextPromise)
      return this._browserContextPromise;
    this._browserContextPromise = this._initializeBrowserContext();
    return this._browserContextPromise;
  }

  private async _initializeBrowserContext() {
    if (this.config.testIdAttribute)
      playwright.selectors.setTestIdAttribute(this.config.testIdAttribute);
    const browserContext = this._rawBrowserContext;
    await this._setupRequestInterception(browserContext);

    for (const initScript of this.config.browser?.initScript || [])
      this._disposables.push(await browserContext.addInitScript({ path: path.resolve(this.options.cwd, initScript) }));

    for (const page of browserContext.pages())
      this._onPageCreated(page);
    this._disposables.push(eventsHelper.addEventListener(browserContext, 'page', page => this._onPageCreated(page)));

    return browserContext;
  }

  checkUrlAllowed(url: string) {
    if (this.config.allowUnrestrictedFileAccess)
      return;
    if (!URL.canParse(url))
      return;
    if (new URL(url).protocol === 'file:')
      throw new Error(`Access to "file:" protocol is blocked. Attempted URL: "${url}"`);
  }

  lookupSecret(secretName: string): { value: string, code: string } {
    if (!this.config.secrets?.[secretName])
      return { value: secretName, code: escapeWithQuotes(secretName, '\'') };
    return {
      value: this.config.secrets[secretName]!,
      code: `process.env['${secretName}']`,
    };
  }

  redactSecrets(text: string): string {
    for (const [secretName, secretValue] of Object.entries(this.config.secrets ?? {})) {
      if (!secretValue)
        continue;
      text = text.replaceAll(secretValue, `<secret>${secretName}</secret>`);
    }
    return text;
  }
}

function originOrHostGlob(originOrHost: string) {
  // Support wildcard port patterns like "http://localhost:*" or "https://example.com:*"
  const wildcardPortMatch = originOrHost.match(/^(https?:\/\/[^/:]+):\*$/);
  if (wildcardPortMatch)
    return `${wildcardPortMatch[1]}:*/**`;

  try {
    const url = new URL(originOrHost);
    // localhost:1234 will parse as protocol 'localhost:' and 'null' origin.
    if (url.origin !== 'null')
      return `${url.origin}/**`;
  } catch {
  }
  // Support for legacy host-only mode.
  return `*://${originOrHost}/**`;
}

export async function workspaceFile(options: ContextOptions, fileName: string, perCallWorkspaceDir?: string): Promise<string> {
  const workspace = perCallWorkspaceDir ?? options.cwd;
  const resolvedName = path.resolve(workspace, fileName);
  await checkFile(options, resolvedName, { origin: 'llm' });
  return resolvedName;
}

export function outputDir(options: ContextOptions): string {
  if (options.config.outputDir)
    return path.resolve(options.config.outputDir);
  const baseName = options.config.skillMode ? '.playwright-cli' : '.playwright-mcp';
  if (isSystemDirectory(options.cwd) || !isWritable(options.cwd))
    return path.join(os.tmpdir(), baseName);
  return path.join(options.cwd, baseName);
}

export async function outputFile(options: ContextOptions, fileName: string, flags: { origin: 'code' | 'llm' }): Promise<string> {
  const dir = outputDir(options);
  let resolvedFile: string;
  if (path.isAbsolute(fileName)) {
    // An absolute path is an explicit caller choice; keep the existing
    // cross-root constraint exactly (output dir or cwd, unless trusted).
    resolvedFile = fileName;
    await checkFile(options, resolvedFile, flags);
  } else {
    // Relative names always resolve inside the output directory, never
    // against process.cwd(). Reject anything that escapes it via `..` (or
    // an embedded absolute component) instead of silently writing outside.
    resolvedFile = path.resolve(dir, fileName);
    if (!isTrustedFileOrigin(options, flags) && !isPathInside(dir, resolvedFile))
      throw new Error(`Output filename "${fileName}" escapes the output directory and was rejected. Output directory: ${dir}`);
  }
  await fs.promises.mkdir(path.dirname(resolvedFile), { recursive: true });
  debug('pw:mcp:file')(resolvedFile);
  return resolvedFile;
}

function isTrustedFileOrigin(options: ContextOptions, flags: { origin: 'code' | 'llm' }): boolean {
  return flags.origin === 'code' || !!options.config.allowUnrestrictedFileAccess || !!options.config.skillMode;
}

async function checkFile(options: ContextOptions, resolvedFilename: string, flags: { origin: 'code' | 'llm' }) {
  // Trust code and unrestricted file access.
  if (isTrustedFileOrigin(options, flags))
    return;

  // Trust llm to use valid characters in file names.
  const output = outputDir(options);
  const workspace = options.cwd;
  if (!isPathInside(output, resolvedFilename) && !isPathInside(workspace, resolvedFilename))
    throw new Error(`File access denied: ${resolvedFilename} is outside allowed roots. Allowed roots: ${output}, ${workspace}`);
}
