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

import { test, expect } from '@playwright/test';
import { tools } from '../../packages/playwright-core/lib/coreBundle';

const { compactAriaSnapshot } = tools;

test('keeps interactive nodes and drops the wrappers around them', () => {
  const { text, kept, dropped } = compactAriaSnapshot(`
- generic [ref=e1]:
  - generic [ref=e2]:
    - list [ref=e3]:
      - listitem [ref=e4]:
        - link "Docs" [ref=e5] [cursor=pointer]:
          - /url: /docs
      - listitem [ref=e6]:
        - button "Search" [ref=e7] [cursor=pointer]
`.trim());

  expect(text).toBe(`- link "Docs" [ref=e5]:
  - /url: /docs
- button "Search" [ref=e7]
# 5 non-interactive nodes omitted (interactiveOnly). This is not a complete view of the page.`);
  expect(kept).toBe(3);
  expect(dropped).toBe(5);
});

test('keeps landmarks and headings as orientation', () => {
  const { text } = compactAriaSnapshot(`
- navigation "Main" [ref=e1]:
  - link "Home" [ref=e2]
- main [ref=e3]:
  - heading "Getting started" [level=1] [ref=e4]
  - paragraph [ref=e5]:
    - text: Some prose that an agent cannot click.
`.trim());

  expect(text).toBe(`- navigation "Main" [ref=e1]:
  - link "Home" [ref=e2]
- main [ref=e3]:
  - heading "Getting started" [level=1] [ref=e4]
# 2 non-interactive nodes omitted (interactiveOnly). This is not a complete view of the page.`);
});

test('keeps state attributes but drops cursor noise', () => {
  const { text } = compactAriaSnapshot(`
- button "Getting Started" [expanded] [ref=e1] [cursor=pointer]
- checkbox "Remember me" [checked] [ref=e2]
- button "Submit" [disabled] [ref=e3] [cursor=pointer]
`.trim());

  expect(text).toBe(`- button "Getting Started" [expanded] [ref=e1]
- checkbox "Remember me" [checked] [ref=e2]
- button "Submit" [disabled] [ref=e3]`);
});

test('drops a property line whose owner was dropped', () => {
  // A bare `/url` under a dropped wrapper names nothing, so it goes with it
  // rather than being promoted into a line that reads as a link with no link.
  const { text, dropped } = compactAriaSnapshot(`
- img "Logo" [ref=e1]:
  - /url: /logo.png
`.trim());

  expect(text).toBe(`# 2 non-interactive nodes omitted (interactiveOnly). This is not a complete view of the page.`);
  expect(dropped).toBe(2);
});

test('says so when it dropped everything', () => {
  const { text, kept, dropped } = compactAriaSnapshot(`
- paragraph [ref=e1]:
  - text: Nothing here can be acted on.
`.trim());

  expect(kept).toBe(0);
  expect(dropped).toBe(2);
  expect(text).toContain('not a complete view of the page');
});

test('adds no note when nothing was dropped', () => {
  const { text, dropped } = compactAriaSnapshot(`- button "Only" [ref=e1]`);

  expect(dropped).toBe(0);
  expect(text).toBe(`- button "Only" [ref=e1]`);
});

test('is a no-op on an empty snapshot', () => {
  expect(compactAriaSnapshot('')).toEqual({ text: '', kept: 0, dropped: 0 });
});

test('keeps a multi-line value with its node', () => {
  const { text } = compactAriaSnapshot(`
- generic [ref=e1]:
  - textbox "Notes" [ref=e2]: |
      first line
      second line
`.trim());

  expect(text).toBe(`- textbox "Notes" [ref=e2]: |
    first line
    second line
# 1 non-interactive nodes omitted (interactiveOnly). This is not a complete view of the page.`);
});
