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

import type * as playwright from '../../..';
import type { Tab } from './tab';
import type { TraceNetworkEntry } from './traceLog';

export async function waitForCompletion<R>(tab: Tab, callback: () => Promise<R>): Promise<R> {
  const settleMs = tab.context.config.timeouts?.settle ?? 500;
  const requests: playwright.Request[] = [];
  const network: TraceNetworkEntry[] = [];

  const requestListener = (request: playwright.Request) => {
    requests.push(request);
    const entry: TraceNetworkEntry = { method: request.method(), url: request.url(), resourceType: request.resourceType() };
    network.push(entry);
    request.response().then(response => {
      if (response)
        entry.status = response.status();
    }).catch(() => {
      entry.failed = true;
    });
  };
  const disposeListeners = () => {
    tab.page.off('request', requestListener);
  };
  tab.page.on('request', requestListener);

  let result: R;
  let settleStart = 0;
  try {
    result = await callback();
    settleStart = Date.now();
    await tab.waitForTimeout(settleMs);
  } finally {
    disposeListeners();
  }

  const requestedNavigation = requests.some(request => request.isNavigationRequest());
  let awaitedRequests = 0;
  if (requestedNavigation) {
    await tab.page.mainFrame().waitForLoadState('load', { timeout: 10000 }).catch(() => {});
  } else {
    const promises: Promise<any>[] = [];
    for (const request of requests) {
      if (['document', 'stylesheet', 'script', 'xhr', 'fetch'].includes(request.resourceType())) {
        awaitedRequests++;
        promises.push(request.response().then(r => r?.finished()).catch(() => {}));
      } else {
        promises.push(request.response().catch(() => {}));
      }
    }
    const timeout = new Promise<void>(resolve => setTimeout(resolve, 5000));
    await Promise.race([Promise.all(promises), timeout]);
    if (requests.length)
      await tab.waitForTimeout(settleMs);
  }

  tab.context.setActionTelemetry({
    network,
    waits: {
      settleMs: Date.now() - settleStart,
      awaitedNavigation: requestedNavigation,
      awaitedRequests,
    },
  });

  return result;
}

export function eventWaiter<T>(page: playwright.Page, event: string, timeout: number): { promise: Promise<T | undefined>, abort: () => void } {
  const disposables: (() => void)[] = [];

  const eventPromise = new Promise<T | undefined>((resolve, reject) => {
    // eslint-disable-next-line no-restricted-syntax
    page.on(event as any, resolve as any);
    // eslint-disable-next-line no-restricted-syntax
    disposables.push(() => page.off(event as any, resolve as any));
  });

  let abort: () => void;
  const abortPromise = new Promise<T | undefined>((resolve, reject) => {
    abort = () => resolve(undefined);
  });

  const timeoutPromise = new Promise<T | undefined>(f => {
    const timeoutId = setTimeout(() => f(undefined), timeout);
    disposables.push(() => clearTimeout(timeoutId));
  });

  return {
    promise: Promise.race([eventPromise, abortPromise, timeoutPromise]).finally(() => disposables.forEach(dispose => dispose())),
    abort: abort!
  };
}
