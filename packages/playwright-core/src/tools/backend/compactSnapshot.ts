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

// Reduces an `ai`-mode aria snapshot to the nodes an agent can act on.
//
// A full snapshot is dominated by material an agent cannot click: on
// playwright.dev/docs/intro, 59 `text` nodes, 51 `generic` wrappers, 118
// `listitem` rows and 21 paragraphs surround 126 links and 15 buttons. That
// material is paid for on every turn, because a snapshot never leaves the
// context once it is read.
//
// The rule is deliberately blunt and stated in the tool description: a node
// survives if it is INTERACTIVE (something a click, type or select can target)
// or ORIENTATION (a landmark or heading that tells the agent where it is).
// Everything else is dropped, and its children are promoted to its parent's
// level, so a link buried under four unnamed wrappers keeps its ref and loses
// the wrappers.
//
// What this mode is NOT: a way to read a page. Page text is exactly what it
// throws away. Reading is what a default snapshot, browser_find or the
// page-affordances digest are for. Because that trade is easy to make by
// accident, the count of everything dropped is appended to the output rather
// than left implicit -- a caller must never read a compact snapshot as a
// complete account of the page.

const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

// Landmarks and headings are orientation, not targets. They are few (one
// `main`, one `contentinfo`, a dozen headings on a large documentation page)
// and without them the survivors arrive as an undifferentiated list of links.
const ORIENTATION_ROLES = new Set([
  'alert',
  'alertdialog',
  'article',
  'banner',
  'complementary',
  'contentinfo',
  'dialog',
  'form',
  'heading',
  'main',
  'navigation',
  'region',
  'search',
  'status',
  'tablist',
]);

// `[cursor=pointer]` is on every link and button on a styled page and says
// nothing that the role has not already said. Every other attribute -- [ref],
// [expanded], [checked], [disabled], [level] -- is state a caller may act on
// and is left exactly as it was.
const CURSOR_ATTRIBUTE = / \[cursor=[^\]]*\]/g;

type SnapshotNode = {
  indent: number;
  text: string;
  role: string;
  isProperty: boolean;
  children: SnapshotNode[];
};

function parseRole(content: string): { role: string, isProperty: boolean } {
  // `- /url: /docs/intro` is a property of the node above it, not a node.
  if (content.startsWith('/'))
    return { role: '', isProperty: true };
  const match = /^([a-zA-Z][a-zA-Z0-9]*)(?=$|[\s:"[])/.exec(content);
  return { role: match ? match[1] : '', isProperty: false };
}

function parse(snapshot: string): SnapshotNode[] {
  const roots: SnapshotNode[] = [];
  const stack: SnapshotNode[] = [];

  for (const line of snapshot.split('\n')) {
    if (!line.trim())
      continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // A line that is not a list item is a continuation of the value above it
    // (a folded or literal YAML block). It belongs to that node and travels
    // with it, rather than being reparented or silently dropped.
    if (!trimmed.startsWith('- ') && stack.length) {
      const owner = stack[stack.length - 1];
      owner.text += '\n' + line;
      continue;
    }

    const content = trimmed.startsWith('- ') ? trimmed.slice(2) : trimmed;
    const { role, isProperty } = parseRole(content);
    const node: SnapshotNode = { indent, text: line, role, isProperty, children: [] };

    while (stack.length && stack[stack.length - 1].indent >= indent)
      stack.pop();
    if (stack.length)
      stack[stack.length - 1].children.push(node);
    else
      roots.push(node);
    stack.push(node);
  }

  return roots;
}

export type CompactSnapshot = {
  text: string;
  kept: number;
  dropped: number;
};

// Re-indents a node's own text to its new depth. Only a node whose value
// spans several lines has anything to move, and its inner lines keep their
// offset relative to the first so a folded block survives the shift.
function reindent(text: string, fromIndent: number, toIndent: number): string {
  const shift = toIndent - fromIndent;
  if (!shift)
    return text;
  return text.split('\n').map(line => {
    if (!line.trim())
      return line;
    const indent = line.length - line.trimStart().length;
    return ' '.repeat(Math.max(0, indent + shift)) + line.trimStart();
  }).join('\n');
}

export function compactAriaSnapshot(snapshot: string): CompactSnapshot {
  const lines: string[] = [];
  let kept = 0;
  let dropped = 0;

  const isKept = (role: string) => INTERACTIVE_ROLES.has(role) || ORIENTATION_ROLES.has(role);

  const walk = (nodes: SnapshotNode[], depth: number, parentKept: boolean) => {
    for (const node of nodes) {
      // A property line outlives its node or not at all: a bare `/url` whose
      // link was dropped names nothing.
      if (node.isProperty) {
        if (parentKept) {
          kept += 1;
          lines.push(reindent(node.text, node.indent, depth * 2));
        } else {
          dropped += 1;
        }
        continue;
      }

      if (isKept(node.role)) {
        kept += 1;
        lines.push(reindent(node.text.replace(CURSOR_ATTRIBUTE, ''), node.indent, depth * 2));
        walk(node.children, depth + 1, true);
      } else {
        dropped += 1;
        // Promoted, not re-nested: the wrapper is gone, so its children take
        // its place at the same depth. Their parent is gone with it, which is
        // why they are walked as parentKept: false.
        walk(node.children, depth, false);
      }
    }
  };

  walk(parse(snapshot), 0, false);

  // Stated, never implied. A caller reading this as the whole page is the one
  // way compact mode can mislead, so the omission is part of the output.
  if (dropped)
    lines.push(`# ${dropped} non-interactive nodes omitted (interactiveOnly). This is not a complete view of the page.`);

  return { text: lines.join('\n'), kept, dropped };
}
