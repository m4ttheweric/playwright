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

export const DEVLOGIN_PREFIX = 'devlogin:';

export function isDevLoginName(value: string): boolean {
  return value.startsWith(DEVLOGIN_PREFIX);
}

export function secretVariants(value: string): string[] {
  const variants = new Set([
    value,
    encodeURIComponent(value),
    encodeURIComponent(value).replace(/%20/g, '+'),
    new URLSearchParams({ v: value }).toString().slice(2),
    JSON.stringify(value).slice(1, -1),
    // Serializers disagree on which characters they escape: text nodes, legacy
    // and current attribute values, and either numeric form of the apostrophe.
    htmlEscape(value, '&<>'),
    htmlEscape(value, '&"'),
    htmlEscape(value, '&"<>'),
    htmlEscape(value, '&"<>\'', '&#39;'),
    htmlEscape(value, '&"<>\'', '&#x27;'),
  ]);
  variants.delete('');
  // Longest first: a shorter variant can be a substring of a longer one.
  return [...variants].sort((a, b) => b.length - a.length);
}

const HTML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function htmlEscape(value: string, chars: string, apostrophe = '&#39;'): string {
  return value.replace(/[&<>"']/g, c => {
    if (!chars.includes(c))
      return c;
    return c === '\'' ? apostrophe : HTML_ENTITIES[c];
  });
}
