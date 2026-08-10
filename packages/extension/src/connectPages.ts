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

import { debugLog } from './relayConnection';

// How long the liveness probe waits before giving up. A relay on loopback
// answers in single-digit milliseconds; a dead one refuses the connection
// immediately. A timeout means neither happened, which we treat as "cannot
// prove it is dead" rather than as death.
const kProbeTimeoutMs = 2000;

export function connectPageUrlPrefix(): string {
  return chrome.runtime.getURL('connect.html');
}

export function isConnectPageUrl(url: string | undefined): boolean {
  return !!url && url.startsWith(connectPageUrlPrefix());
}

// The relay stamps its liveness endpoint into the connect page URL, so any
// connect page tab carries everything needed to check on the client that
// opened it -- no bookkeeping that a service worker restart could lose.
function aliveUrlFromConnectPageUrl(url: string): string | undefined {
  try {
    const aliveUrl = new URLSearchParams(new URL(url).search).get('mcpAliveUrl');
    if (!aliveUrl)
      return undefined;
    const parsed = new URL(aliveUrl);
    // Same loopback restriction the connect page applies to the relay URL.
    if (parsed.protocol !== 'http:' || (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]' && parsed.hostname !== '::1'))
      return undefined;
    return aliveUrl;
  } catch {
    return undefined;
  }
}

type Liveness = 'alive' | 'dead' | 'unknown';

async function probeRelay(aliveUrl: string): Promise<Liveness> {
  try {
    const response = await fetch(aliveUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(kProbeTimeoutMs),
    });
    // Only our own relay answers this path with 204. Anything else means the
    // port is no longer served by the client that opened the page.
    return response.status === 204 ? 'alive' : 'dead';
  } catch (error: any) {
    // A refused connection is proof of death; a timeout is not.
    return error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'unknown' : 'dead';
  }
}

// Closes connect page tabs whose relay is gone. Only tabs this extension
// itself opened are considered, and only ones we can positively prove are
// orphaned -- a page still waiting on a live client, or one we cannot reach a
// verdict on, is always left alone.
export async function sweepOrphanedConnectPages(keepTabIds: Iterable<number> = []): Promise<number[]> {
  const keep = new Set(keepTabIds);
  try {
    // Filtered here rather than via a query pattern: chrome-extension:// is not
    // a valid match pattern scheme for chrome.tabs.query.
    const tabs = await chrome.tabs.query({});
    const candidates = tabs.filter(tab => tab.id !== undefined && !keep.has(tab.id) && isConnectPageUrl(tab.url));
    const verdicts = await Promise.all(candidates.map(async tab => {
      const aliveUrl = aliveUrlFromConnectPageUrl(tab.url ?? '');
      // No endpoint advertised (a page opened by an older runtime): unprovable,
      // so leave it.
      if (!aliveUrl)
        return 'unknown' as Liveness;
      return await probeRelay(aliveUrl);
    }));
    const orphanIds = candidates.filter((_, i) => verdicts[i] === 'dead').map(tab => tab.id!);
    if (orphanIds.length) {
      debugLog(`Closing ${orphanIds.length} orphaned connect page(s):`, orphanIds);
      await chrome.tabs.remove(orphanIds).catch(error => {
        debugLog('Error closing orphaned connect pages:', error);
      });
    }
    return orphanIds;
  } catch (error: any) {
    debugLog('Error sweeping orphaned connect pages:', error);
    return [];
  }
}
