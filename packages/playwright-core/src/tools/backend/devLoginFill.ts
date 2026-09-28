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

const READBACK_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const RETRY_WAITS_MS = [0, 20, 100, 100, 500];

export async function fillDevLogin(tab: Tab, locator: playwright.Locator, name: string): Promise<void> {
  tab.context.beginDevLoginFill();
  try {
    await fillLocator(tab, locator, name);
  } finally {
    tab.context.endDevLoginFill();
  }
}

async function fillLocator(tab: Tab, locator: playwright.Locator, name: string) {
  const handle = await locator.elementHandle(tab.actionTimeoutOptions);
  let approved: { frame: playwright.Frame, frameOrigin: string, value: string };
  try {
    approved = await requestValue(tab, handle, name);
  } catch (error) {
    await handle.dispose().catch(() => {});
    if (error instanceof DevLoginRefusedError) {
      // eslint-disable-next-line no-restricted-properties
      process.stderr.write(`saved login ${name} refused: ${error.reason}\n`);
    }
    throw error;
  }
  tab.context.rememberFilledSecret(name, approved.value);
  // The lock owns the handle from here: a fill that throws may still have left the value in the input.
  tab.context.lockReadback(approved.frame, handle);
  await setValue(handle, approved.value, tab.actionTimeoutOptions.timeout ?? DEFAULT_ACTION_TIMEOUT_MS);
  // eslint-disable-next-line no-restricted-properties
  process.stderr.write(`filled saved login for ${approved.frameOrigin}\n`);
}

async function requestValue(tab: Tab, handle: playwright.ElementHandle<SVGElement | HTMLElement>, name: string) {
  if (tab.context.isRecording())
    throw new DevLoginRefusedError(name, 'recording');
  const channel = secretsChannel(tab.context.config.secretsChannelFd);
  if (!channel)
    throw new DevLoginRefusedError(name, 'no-channel');
  const frame = await handle.ownerFrame();
  const frameOrigin = frame ? await frameSecurityOrigin(frame) : undefined;
  if (!frame || !frameOrigin)
    throw new DevLoginRefusedError(name, 'opaque-origin');
  const elementKind = await handle.evaluate(el => el.localName === 'input' && (el as HTMLInputElement).type === 'password') ? 'password' : 'text';
  if (!await tab.context.waitForReadbackCallsToDrain(READBACK_DRAIN_TIMEOUT_MS))
    throw new DevLoginRefusedError(name, 'timeout');
  // A recording tool that was still running during the first check may have started one.
  if (tab.context.isRecording())
    throw new DevLoginRefusedError(name, 'recording');
  const reply = await channel.request(name, frameOrigin, elementKind);
  if (reply === 'timeout' || reply === 'no-channel')
    throw new DevLoginRefusedError(name, reply);
  if ('refused' in reply)
    throw new DevLoginRefusedError(name, reply.refused, reply.until);
  if (reply.origin !== frameOrigin || (reply.kind === 'password' && elementKind !== 'password'))
    throw new DevLoginRefusedError(name, 'mismatch');
  return { frame, frameOrigin, value: reply.value };
}

// Keyboard input lands in whichever frame holds focus, and a hostile frame can take focus between
// the focus call and the keystrokes, so the value is set on the element itself in the isolated world.
async function setValue(handle: playwright.ElementHandle, value: string, timeout: number) {
  // eslint-disable-next-line no-restricted-syntax -- the isolated world is only reachable on the in-process server objects.
  const serverHandle = (handle as any)._connection?.toImpl?.(handle);
  if (typeof serverHandle?.evaluateInUtility !== 'function')
    throw new Error('The saved login cannot be filled: the element is not reachable.');
  const deadline = timeout ? Date.now() + timeout : Infinity;
  for (let retry = 0; ; retry++) {
    const result = await raceDeadline<SetValueResult>(serverHandle.evaluateInUtility(setValueInPage, value), deadline, timeout);
    if (result === 'done')
      return;
    if (result === 'error:notconnected')
      throw new Error('Element is not attached to the DOM');
    const wait = RETRY_WAITS_MS[Math.min(retry, RETRY_WAITS_MS.length - 1)];
    if (Date.now() + wait >= deadline)
      throw new Error(`Timeout ${timeout}ms exceeded: element is not ${result.missingState}`);
    await new Promise(f => setTimeout(f, wait));
  }
}

async function raceDeadline<T>(promise: Promise<T>, deadline: number, timeout: number): Promise<T> {
  if (deadline === Infinity)
    return await promise;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => timer = setTimeout(() => reject(new Error(`Timeout ${timeout}ms exceeded.`)), Math.max(0, deadline - Date.now())));
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

type SetValueResult = 'done' | 'error:notconnected' | { missingState: string };

// Serialized into the utility world: it may reference nothing outside its own body.
async function setValueInPage([injected, node, value]: [any, Node, string]): Promise<SetValueResult> {
  const missing = await injected.checkElementStates(node, ['visible', 'enabled', 'editable']);
  if (missing)
    return missing;
  const element = injected.retarget(node, 'follow-label') as Element | null;
  if (!element)
    return 'error:notconnected';
  let prototype: HTMLInputElement | HTMLTextAreaElement;
  if (element.nodeName.toLowerCase() === 'input') {
    const type = (element as HTMLInputElement).type.toLowerCase();
    if (!['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url'].includes(type))
      throw injected.createStacklessError(`Input of type "${type}" cannot be filled`);
    if (type === 'number') {
      value = value.trim();
      if (isNaN(Number(value)))
        throw injected.createStacklessError('Cannot type text into input[type=number]');
    }
    prototype = HTMLInputElement.prototype;
  } else if (element.nodeName.toLowerCase() === 'textarea') {
    prototype = HTMLTextAreaElement.prototype;
  } else {
    throw injected.createStacklessError('Element is not an <input> or <textarea> element');
  }
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return 'done';
}
