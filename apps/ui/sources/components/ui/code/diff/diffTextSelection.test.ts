import { describe, expect, it } from 'vitest';

import {
  readDiffLineFromDomNode,
  resolveDiffSelectionLines,
} from './diffTextSelection';

type FakeElement = Readonly<{
  nodeType: 1;
  parentElement: FakeElement | null;
  attributes: Readonly<Record<string, string>>;
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
}>;

function element(
  attributes: Record<string, string>,
  parentElement: FakeElement | null = null,
): FakeElement {
  return {
    nodeType: 1,
    parentElement,
    attributes,
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => name in attributes,
  };
}
const text = (parentElement: FakeElement) => ({ nodeType: 3, parentElement });

describe('diff text selection lines', () => {
  it("reads a Happier diff row's old and new numbers from the row the text sits in", () => {
    const added = element({
      'data-code-line-kind': 'add',
      'data-code-line-new': '12',
    });
    const context = element({
      'data-code-line-kind': 'context',
      'data-code-line-old': '9',
      'data-code-line-new': '13',
    });
    expect(readDiffLineFromDomNode(text(element({}, added)))).toEqual({
      oldLine: null,
      newLine: 12,
    });
    expect(readDiffLineFromDomNode(text(context))).toEqual({
      oldLine: 9,
      newLine: 13,
    });
    expect(readDiffLineFromDomNode(text(element({ id: 'pane' })))).toBeNull();
  });

  it('reads a Pierre row by its line type and column (deletions column is the old side)', () => {
    const deletionsColumn = element({ 'data-code': '', 'data-deletions': '' });
    const additionsColumn = element({ 'data-code': '', 'data-additions': '' });
    const removed = element(
      { 'data-line': '7', 'data-line-type': 'change-deletion' },
      additionsColumn,
    );
    const oldContext = element(
      { 'data-line': '5', 'data-line-type': 'context' },
      deletionsColumn,
    );
    const newContext = element(
      { 'data-line': '6', 'data-line-type': 'context' },
      additionsColumn,
    );
    expect(readDiffLineFromDomNode(text(element({}, removed)))).toEqual({
      oldLine: 7,
      newLine: null,
    });
    expect(readDiffLineFromDomNode(text(oldContext))).toEqual({
      oldLine: 5,
      newLine: null,
    });
    expect(readDiffLineFromDomNode(text(newContext))).toEqual({
      oldLine: null,
      newLine: 6,
    });
  });

  it('asks about the new side unless the selection only covers removed lines', () => {
    expect(
      resolveDiffSelectionLines(
        { oldLine: 9, newLine: 13 },
        { oldLine: null, newLine: 11 },
      ),
    ).toEqual({ startLine: 11, endLine: 13, side: 'after' });
    // From a removed line into the added lines that replace it: the new lines it lands on.
    expect(
      resolveDiffSelectionLines(
        { oldLine: 20, newLine: null },
        { oldLine: null, newLine: 22 },
      ),
    ).toEqual({ startLine: 22, endLine: 22, side: 'after' });
    expect(
      resolveDiffSelectionLines(
        { oldLine: 21, newLine: null },
        { oldLine: 20, newLine: null },
      ),
    ).toEqual({ startLine: 20, endLine: 21, side: 'before' });
    expect(
      resolveDiffSelectionLines(null, { oldLine: null, newLine: 3 }),
    ).toBeNull();
  });
});
