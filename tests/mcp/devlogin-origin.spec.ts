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

import { test, expect } from './fixtures';
import { tools } from '../../packages/playwright-core/lib/coreBundle';

const { wireOrigin } = tools;

for (const [input, expected] of [
  ['https://login.example.com', 'https://login.example.com'],
  ['HTTPS://Login.Example.COM', 'https://login.example.com'],
  ['https://login.example.com:443', 'https://login.example.com'],
  ['http://localhost:80', 'http://localhost'],
  ['http://localhost:3000', 'http://localhost:3000'],
  ['https://login.example.com/', 'https://login.example.com'],
  ['https://bücher.example', 'https://xn--bcher-kva.example'],
  ['null', undefined],
  ['', undefined],
  ['about:blank', undefined],
  ['data:text/html,x', undefined],
  ['chrome-extension://abcdef', undefined],
] as const) {
  test(`wireOrigin(${JSON.stringify(input)})`, () => {
    expect(wireOrigin(input)).toBe(expected);
  });
}
