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

import { RelayConnection, debugLog, isOwnUiUrl } from './relayConnection';
import { isConnectPageUrl } from './connectPages';

const NON_DEBUGGABLE_SCHEMES = ['chrome:', 'edge:', 'devtools:'];
const CONNECTED_BADGE = { text: '✓', color: '#4CAF50', title: 'Connected to Fast Browser client' };
// Title used by extension versions that supported a single connection. Still
// matched during cleanup so an upgrade reconciles groups they left behind.
const LEGACY_GROUP_TITLE = 'Playwright';
// storage.local key listing tab group titles created by this extension, so a
// restarted service worker can recognize which groups are stale.
const GROUP_TITLES_KEY = 'playwrightGroupTitles';

export type GroupStyle = {
  title: string;
  color: NonNullable<chrome.tabGroups.UpdateProperties['color']>;
};

export function isNonDebuggableUrl(url: string | undefined): boolean {
  return !!url && NON_DEBUGGABLE_SCHEMES.some(s => url.startsWith(s));
}

// storage.local writes are read-modify-write, so serialize them to avoid
// losing a title when two connections create groups at the same time.
let groupTitlesWriteQueue: Promise<void> = Promise.resolve();

function registerGroupTitle(title: string): Promise<void> {
  groupTitlesWriteQueue = groupTitlesWriteQueue.then(async () => {
    const stored = await chrome.storage.local.get(GROUP_TITLES_KEY);
    const titles: string[] = stored[GROUP_TITLES_KEY] ?? [];
    if (!titles.includes(title))
      await chrome.storage.local.set({ [GROUP_TITLES_KEY]: [...titles, title] });
  }).catch((error: any) => {
    debugLog('Error registering group title:', error);
  });
  return groupTitlesWriteQueue;
}

// Ungroups any groups left behind by a prior service worker, identified by the
// titles that service worker registered in storage.local.
export async function cleanupStalePlaywrightGroups(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(GROUP_TITLES_KEY);
    const staleTitles = new Set<string>([...(stored[GROUP_TITLES_KEY] ?? []), LEGACY_GROUP_TITLE]);
    const groups = await chrome.tabGroups.query({});
    const staleGroups = groups.filter(g => g.title !== undefined && staleTitles.has(g.title));
    const tabsPerGroup = await Promise.all(staleGroups.map(g => chrome.tabs.query({ groupId: g.id })));
    const tabIds = tabsPerGroup.flat().map(t => t.id).filter((id): id is number => id !== undefined);
    if (tabIds.length)
      await chrome.tabs.ungroup(tabIds);
    await chrome.storage.local.remove(GROUP_TITLES_KEY);
  } catch (error: any) {
    debugLog('Error cleaning up stale groups:', error);
  }
}

// The Playwright tab group for an active RelayConnection. The Chrome tab group
// is the single source of truth for which tabs the client targets:
//  - User drags a tab in/out → `_onTabGroupChanged` attaches/detaches.
//  - Relay attaches on its own (initial tab, popup, Target.createTarget) →
//    `_onTabAttached` pulls the new tab into the group, whose onUpdated event
//    flows back through `_onTabGroupChanged` for consistency.
// `_groupTabIds` caches group membership from Chrome events so hot-path checks
// in `_onTabUpdated` stay synchronous.
export class ConnectedTabGroup {
  private _connection: RelayConnection;
  private _style: GroupStyle;
  private _connectPageTabId: number;
  private _groupId: number | null = null;
  private _groupTabIds: Set<number> = new Set();
  // Tabs this session brought into being (relay chrome.tabs.create, popups
  // from controlled pages), as opposed to tabs the user selected or dragged
  // in. Session-created tabs close with a cleanly-ended session (FB-59);
  // user tabs are only ever ungrouped.
  private _sessionCreatedTabIds: Set<number> = new Set();
  private _onTabUpdatedListener: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void;
  private _onTabRemovedListener: (tabId: number) => void;

  onclose?: () => void;

  constructor(connection: RelayConnection, selectedTab: chrome.tabs.Tab, style: GroupStyle, connectPageTabId: number) {
    this._connection = connection;
    this._style = style;
    this._connectPageTabId = connectPageTabId;
    this._connection.onclose = (clean: boolean) => this._onConnectionClose(clean);
    this._connection.ontabattached = (tabId: number) => this._onTabAttached(tabId);
    this._connection.ontabdetached = (tabId: number) => this._onTabDetached(tabId);
    this._connection.ontabcreated = (tabId: number) => this._sessionCreatedTabIds.add(tabId);
    this._onTabUpdatedListener = this._onTabUpdated.bind(this);
    this._onTabRemovedListener = this._onTabRemoved.bind(this);
    chrome.tabs.onUpdated.addListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.addListener(this._onTabRemovedListener);
    // Seed the relay with the user-selected tab, then close out the initial
    // handshake. The relay holds Playwright-side CDP traffic until
    // `didInitialize` arrives, so it sees a fully populated tab model by the
    // time it handles `Target.setAutoAttach`.
    this._connection.attachTab(selectedTab);
    this._connection.didInitialize();
  }

  connectedTabIds(): number[] {
    return [...this._groupTabIds];
  }

  close(reason: string): void {
    this._connection.close(reason);
  }

  private _onTabUpdated(tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab): void {
    if (changeInfo.groupId !== undefined)
      this._onTabGroupChanged(tabId, tab);
    // A same-url reload (an anti-bot challenge reloading after it solves,
    // FB-58) surfaces here with only a `status` change -- `url` is present
    // only when it changed. Both shapes mean the tab is making load progress,
    // which is the re-attach cue for a group tab Chrome detached.
    if (changeInfo.url === undefined && changeInfo.status === undefined)
      return;
    const url = changeInfo.url ?? tab.url;
    // Chrome resets per-tab badge state on navigation, so re-apply it.
    if (this._connection.attachedTabs.has(tabId))
      void this._updateBadge(tabId, CONNECTED_BADGE);
    else if (this._groupTabIds.has(tabId) && !isNonDebuggableUrl(url) && !isOwnUiUrl(url))
      this._connection.attachTab(tab);
  }

  // Single entry point for group membership changes, whether the user dragged
  // or we grouped the tab ourselves. Attaches on entry (if debuggable) and
  // detaches on exit; a chrome:// tab stays in the group until it navigates
  // (handled in _onTabUpdated).
  private _onTabGroupChanged(tabId: number, tab: chrome.tabs.Tab): void {
    const inOurGroup = this._groupId !== null && tab.groupId === this._groupId;
    const wasInGroup = this._groupTabIds.has(tabId);
    if (inOurGroup === wasInGroup)
      return;
    if (inOurGroup) {
      this._groupTabIds.add(tabId);
      if (!isNonDebuggableUrl(tab.url) && !isOwnUiUrl(tab.url))
        this._connection.attachTab(tab);
    } else {
      this._groupTabIds.delete(tabId);
      if (this._connection.attachedTabs.has(tabId))
        this._connection.detachTab(tabId);
    }
  }

  private _onTabRemoved(tabId: number): void {
    this._groupTabIds.delete(tabId);
    this._sessionCreatedTabIds.delete(tabId);
  }

  private _onTabAttached(tabId: number): void {
    void this._updateBadge(tabId, CONNECTED_BADGE);
    void this._addTabToGroup(tabId);
  }

  // The debugger detached (drag-out, tab close, or external action). Clear the
  // badge but leave the tab in the group — the user's intent is still there,
  // and a subsequent navigation will re-attach via _onTabUpdated.
  private _onTabDetached(tabId: number): void {
    void this._updateBadge(tabId, { text: '' });
    void this._reattachSurvivors();
  }

  // Runs after any detach. When Chrome detaches the debugger on its own the
  // tab usually survives -- a Memory Saver discard keeps it in the strip and
  // in this group, just under a new tab id -- so the group, not the stale id,
  // is what we re-attach from. Re-attaching cancels the pending close in
  // RelayConnection; finding nothing lets that close go ahead.
  private async _reattachSurvivors(): Promise<void> {
    if (this._groupId === null || this._connection.attachedTabs.size > 0)
      return;
    try {
      const tabs = await chrome.tabs.query({ groupId: this._groupId });
      for (const tab of tabs) {
        if (tab.id === undefined || isNonDebuggableUrl(tab.url) || isOwnUiUrl(tab.url))
          continue;
        this._groupTabIds.add(tab.id);
        this._connection.attachTab(tab);
      }
    } catch (error: any) {
      debugLog('Error re-attaching after an involuntary detach:', error);
    }
  }

  private _onConnectionClose(clean: boolean): void {
    chrome.tabs.onUpdated.removeListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.removeListener(this._onTabRemovedListener);
    const groupTabs = [...this._groupTabIds];
    this._groupTabIds.clear();
    // Chrome's "started debugging" infobar sticks to each debugged tab until
    // the tab closes or the user dismisses it (FB-59). Tabs this session
    // created are its scaffolding, like the connect page below: on a clean
    // end they close, taking their dead banners with them. Tabs the user
    // brought in are only ungrouped. An unclean drop preserves everything --
    // the user may still want those pages after a crash.
    const toClose = clean ? groupTabs.filter(id => this._sessionCreatedTabIds.has(id)) : [];
    const toUngroup = groupTabs.filter(id => !this._sessionCreatedTabIds.has(id) || !clean);
    this._sessionCreatedTabIds.clear();
    if (toClose.length) {
      chrome.tabs.remove(toClose).catch(error => {
        debugLog('Error closing session-created tabs on close:', error);
      });
    }
    if (toUngroup.length) {
      this._retryOnDrag(() => chrome.tabs.ungroup(toUngroup)).catch(error => {
        debugLog('Error ungrouping tabs on close:', error);
      });
    }
    void this._closeConnectPage();
    this.onclose?.();
  }

  // The connect page is this extension's own scaffolding, so it goes away with
  // the session that raised it -- whether the client exited cleanly or its
  // socket simply died. Once the client has navigated that tab somewhere it is
  // showing real content, and closing it would destroy the user's page rather
  // than tidy up after ourselves, so the URL check is the whole guard.
  private async _closeConnectPage(): Promise<void> {
    try {
      const tab = await chrome.tabs.get(this._connectPageTabId);
      if (isConnectPageUrl(tab.url) || isConnectPageUrl(tab.pendingUrl))
        await chrome.tabs.remove(this._connectPageTabId);
    } catch {
      // Already closed, or replaced by the client; nothing to tidy.
    }
  }

  private async _updateBadge(tabId: number, { text, color, title }: { text: string; color?: string, title?: string }): Promise<void> {
    try {
      await Promise.all([
        chrome.action.setBadgeText({ tabId, text }),
        chrome.action.setTitle({ tabId, title: title || '' }),
        color ? chrome.action.setBadgeBackgroundColor({ tabId, color }) : Promise.resolve(),
      ]);
    } catch (error: any) {
      // Ignore errors as the tab may be closed already.
    }
  }

  // Moves an already-attached tab into our Chrome tab group, creating it on
  // first use. `_groupTabIds` is updated after the await so an onUpdated event
  // that arrives concurrently (`_groupId` still null, wasInGroup still false)
  // becomes a harmless no-op rather than taking the drag-out branch.
  private async _addTabToGroup(tabId: number): Promise<void> {
    if (this._groupTabIds.has(tabId))
      return;
    try {
      await this._retryOnDrag(async () => {
        if (this._groupId === null) {
          this._groupId = await chrome.tabs.group({ tabIds: [tabId] });
          await chrome.tabGroups.update(this._groupId, { color: this._style.color, title: this._style.title });
          await registerGroupTitle(this._style.title);
        } else {
          await chrome.tabs.group({ groupId: this._groupId, tabIds: [tabId] });
        }
      });
      this._groupTabIds.add(tabId);
    } catch (error: any) {
      debugLog('Error adding tab to group:', error);
    }
  }

  // Chrome throws "user may be dragging a tab" while a drag is in progress.
  // Retry with backoff until it clears (or we give up).
  private async _retryOnDrag(fn: () => Promise<void>): Promise<void> {
    const delays = [0, 100, 200, 400, 800];
    let lastError: unknown;
    for (const delay of delays) {
      if (delay)
        await new Promise(resolve => setTimeout(resolve, delay));
      try {
        await fn();
        return;
      } catch (error: any) {
        if (!error?.message?.includes('user may be dragging a tab'))
          throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
}
