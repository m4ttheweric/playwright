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

import { DevLoginRefusedError } from './devlogin';
import { frameSecurityOrigin } from './frameOrigin';
import { secretsChannel } from './secretsChannel';

import type * as playwright from '../../..';
import type { Tab } from './tab';

export async function fillDevLogin(tab: Tab, locator: playwright.Locator, name: string): Promise<void> {
  const handle = await locator.elementHandle(tab.actionTimeoutOptions);
  let frame: playwright.Frame;
  try {
    frame = await fillHandle(tab, handle, name);
  } catch (error) {
    await handle.dispose().catch(() => {});
    if (error instanceof DevLoginRefusedError) {
      // eslint-disable-next-line no-restricted-properties
      process.stderr.write(`saved login ${name} refused: ${error.reason}\n`);
    }
    throw error;
  }
  tab.context.lockReadback(frame, handle);
}

async function fillHandle(tab: Tab, handle: playwright.ElementHandle<SVGElement | HTMLElement>, name: string): Promise<playwright.Frame> {
  if (tab.context.isRecording())
    throw new DevLoginRefusedError(name, 'recording');
  const channel = secretsChannel(tab.context.config.secretsChannelFd);
  if (!channel)
    throw new DevLoginRefusedError(name, 'no-channel');
  const frame = await handle.ownerFrame();
  const frameOrigin = frame ? await frameSecurityOrigin(frame) : undefined;
  if (!frameOrigin)
    throw new DevLoginRefusedError(name, 'opaque-origin');
  const elementKind = await handle.evaluate(el => el.localName === 'input' && (el as HTMLInputElement).type === 'password') ? 'password' : 'text';
  const reply = await channel.request(name, frameOrigin, elementKind);
  if (reply === 'timeout' || reply === 'no-channel')
    throw new DevLoginRefusedError(name, reply);
  if ('refused' in reply)
    throw new DevLoginRefusedError(name, reply.refused, reply.until);
  if (reply.origin !== frameOrigin || (reply.kind === 'password' && elementKind !== 'password'))
    throw new DevLoginRefusedError(name, 'mismatch');
  tab.context.rememberFilledSecret(name, reply.value);
  await handle.fill(reply.value, tab.actionTimeoutOptions);
  // eslint-disable-next-line no-restricted-properties
  process.stderr.write(`filled saved login for ${frameOrigin}\n`);
  return frame!;
}
