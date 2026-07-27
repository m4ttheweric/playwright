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

import { isOwnUiUrl, debugLog } from './relayConnection';

// A background-agent (token-bypass) connection opens its connect.html tab via
// a native OS-level `spawn(executablePath, [url])` in
// CDPRelayServer._openConnectPageInBrowser. When Chrome is already running,
// that hands the URL to the already-running instance over Chrome's own
// process-singleton IPC, which creates the tab active and raises the window
// *before any extension code runs*. There is no extension API that runs
// early enough to stop that first steal (nor a Chrome launch flag that
// suppresses it; both were investigated and ruled out). The best available
// fix is to revert it immediately: as soon as the tab exists, restore
// whichever tab/window was active immediately beforehand. A manual
// connection's connect.html has no `token` param and is left alone so the
// user still sees the Allow dialog pop to the front, exactly as today.
export class FocusGuard {
  // Updated only from onActivated, so a not-yet-processed onCreated handler
  // still observes the tab that was active immediately before the new one
  // arrived, not the new one itself.
  private _lastActiveTabByWindow = new Map<number, number>();

  constructor() {
    chrome.tabs.onActivated.addListener(info => {
      this._lastActiveTabByWindow.set(info.windowId, info.tabId);
    });
    chrome.tabs.onCreated.addListener(tab => {
      void this._maybeRestoreFocus(tab);
    });
    // Seed a baseline immediately (service workers can be woken up by the
    // very tab creation we need to react to, leaving onActivated with
    // nothing recorded yet).
    void chrome.tabs.query({ active: true }).then(tabs => {
      for (const tab of tabs) {
        if (tab.windowId !== undefined && tab.id !== undefined)
          this._lastActiveTabByWindow.set(tab.windowId, tab.id);
      }
    }).catch(() => {});
  }

  private async _maybeRestoreFocus(tab: chrome.tabs.Tab): Promise<void> {
    if (tab.id === undefined || tab.windowId === undefined)
      return;
    if (!isBackgroundConnectTab(tab))
      return;
    const previousTabId = this._lastActiveTabByWindow.get(tab.windowId);
    // No prior tab recorded for this window: either the very first window of
    // a cold start, or a genuinely new window. Nothing to revert to, and
    // cold start must keep working, so leave it as Chrome made it.
    if (previousTabId === undefined || previousTabId === tab.id)
      return;
    try {
      const previousTab = await chrome.tabs.get(previousTabId);
      // Activating the previous tab is sufficient: Chrome allows only one
      // active tab per window, so this implicitly deactivates the new one.
      await chrome.tabs.update(previousTabId, { active: true });
      await chrome.windows.update(previousTab.windowId, { focused: true });
    } catch (error: any) {
      // Previous tab/window closed in the meantime; nothing to restore.
      debugLog('Error restoring focus after background connect:', error.message);
    }
  }
}

function isBackgroundConnectTab(tab: chrome.tabs.Tab): boolean {
  const url = tab.url || tab.pendingUrl;
  if (!url || !isOwnUiUrl(url) || !url.startsWith(chrome.runtime.getURL('connect.html')))
    return false;
  try {
    // Presence of a `token` param is exactly the signal connect.tsx itself
    // uses to auto-approve without showing the Allow dialog (see
    // ui/connect.tsx), so it is the authoritative "this is a background
    // agent, not a human" signal available at tab-creation time.
    return !!new URL(url).searchParams.get('token');
  } catch {
    return false;
  }
}
