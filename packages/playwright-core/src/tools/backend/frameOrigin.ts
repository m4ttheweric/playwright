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

type CdpFrame = { id: string, url: string, securityOrigin?: string };
type CdpFrameTree = { frame: CdpFrame, childFrames?: CdpFrameTree[] };

export async function frameSecurityOrigin(frame: playwright.Frame): Promise<string | undefined> {
  // eslint-disable-next-line no-restricted-syntax -- the browser's own frame origin is only reachable on the in-process server objects.
  const serverFrame = (frame as any)._connection?.toImpl?.(frame);
  const crPage = serverFrame?._page?.delegate;
  if (typeof crPage?._sessionForFrame !== 'function')
    return undefined;
  const session = crPage._sessionForFrame(serverFrame);
  const { frameTree } = await session._client.send('Page.getFrameTree') as { frameTree: CdpFrameTree };
  const cdpFrame = findFrame(frameTree, serverFrame._id);
  const origin = wireOrigin(cdpFrame?.securityOrigin);
  if (!origin || !cdpFrame || !URL.canParse(cdpFrame.url))
    return undefined;
  const url = new URL(cdpFrame.url);
  // about:blank and about:srcdoc inherit their creator's origin, so the origin alone does not prove the document came from it.
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== origin)
    return undefined;
  // A sandboxed frame keeps its URL's origin in the frame tree; only its document's execution context reports the opaque origin.
  const mainContext = serverFrame._existingMainContext?.();
  if (wireOrigin(mainContext?.delegate?.origin) !== origin)
    return undefined;
  return origin;
}

function findFrame(tree: CdpFrameTree, id: string): CdpFrame | undefined {
  if (tree.frame.id === id)
    return tree.frame;
  for (const child of tree.childFrames ?? []) {
    const found = findFrame(child, id);
    if (found)
      return found;
  }
  return undefined;
}

// The daemon compares this string to the saved origin byte for byte.
export function wireOrigin(securityOrigin: string | undefined): string | undefined {
  if (!securityOrigin || securityOrigin === 'null' || !URL.canParse(securityOrigin))
    return undefined;
  const url = new URL(securityOrigin);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return undefined;
  return url.origin;
}
