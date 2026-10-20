import { describe, expect, it } from 'vitest';
import { applyHunks, applyInverseEdits, describeHunkRange, formatHunk, parseUnifiedDiffHunks, revertHunks } from './hunks.js';

describe('lossless unified hunks', () => {
  it('accepts a CRLF hunk header while retaining CR in added lines', () => {
    const hunks = parseUnifiedDiffHunks('@@ -0,0 +1,2 @@\r\n+one\r\n+two\r\n');
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines).toEqual([{ kind: 'add', text: 'one\r' }, { kind: 'add', text: 'two\r' }]);
    expect(applyHunks('', hunks)).toEqual({ ok: true, text: 'one\r\ntwo\r\n' });
  });
  it('preserves BOM, CR and missing final LF through parsing, formatting and reversal', () => {
    const patch = '@@ -1,2 +1,2 @@ title\n \uFEFFhead\r\n-old\r\n+new\r\n\\ No newline at end of file\n';
    const hunks = parseUnifiedDiffHunks(patch);
    expect(hunks).toEqual([{ index: 0, oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
      sectionHeading: 'title', firstChange: 1, lastChange: 2, lines: [
        { kind: 'context', text: '\uFEFFhead\r' }, { kind: 'remove', text: 'old\r' }, { kind: 'add', text: 'new\r', noEol: true },
      ] }]);
    expect(formatHunk(hunks[0]!)).toBe(patch);
    expect(revertHunks('\uFEFFhead\r\nnew\r', hunks)).toEqual({ ok: true, text: '\uFEFFhead\r\nold\r\n' });
    expect(applyHunks('\uFEFFhead\r\nold\r\n', hunks)).toEqual({ ok: true, text: '\uFEFFhead\r\nnew\r' });
    expect(revertHunks('\uFEFFhead\nnew\r', hunks)).toEqual({ ok: false, reason: 'moved_on' });
    expect(revertHunks('\uFEFFhead\r\nnew\r\n', hunks)).toEqual({ ok: false, reason: 'moved_on' });
  });
  it('applies unordered subsets bottom-up and refuses overlap or mismatching context atomically', () => {
    const hunks = parseUnifiedDiffHunks('@@ -1,2 +1,3 @@\n one\n-old\n+new\n+extra\n@@ -4 +5 @@\n-tail\n+last\n');
    expect(revertHunks('one\nnew\nextra\nmiddle\nlast\n', [...hunks].reverse())).toEqual({ ok: true, text: 'one\nold\nmiddle\ntail\n' });
    expect(revertHunks('one\nnew\nextra\nmiddle\nLAST\n', hunks)).toEqual({ ok: false, reason: 'moved_on' });
    expect(revertHunks('one\nnew\nextra\nmiddle\nlast\n', [hunks[0]!, hunks[0]!])).toEqual({ ok: false, reason: 'overlap' });
    expect(revertHunks('one\nnew\nextra\n', [{ ...hunks[0]!, newLines: 8 }])).toEqual({ ok: false, reason: 'invalid_hunk' });
  });
  it('handles empty-side anchors, added and deleted files and binary sections', () => {
    const added = parseUnifiedDiffHunks('diff --git a/a b/a\nnew file mode 100644\n--- /dev/null\n+++ b/a\n@@ -0,0 +1 @@\n+hello\n');
    const deleted = parseUnifiedDiffHunks('@@ -1 +0,0 @@\n-hello\n');
    expect(revertHunks('hello\n', added)).toEqual({ ok: true, text: '' });
    expect(revertHunks('', deleted)).toEqual({ ok: true, text: 'hello\n' });
    expect(describeHunkRange(deleted[0]!)).toEqual({ startLine: 1, endLine: 1, side: 'old' });
    expect(parseUnifiedDiffHunks('diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n')).toEqual([]);
    expect(parseUnifiedDiffHunks('Binary files a/a and b/a differ\n')).toEqual([]);
  });
  it('round-trips generated exact edits including empty text and EOF changes', () => {
    for (const eol of ['\n', '\r\n']) for (const finalNewline of [false, true]) for (let count = 1; count <= 12; count++) {
      const oldLines = Array.from({ length: count }, (_, i) => `old${i}${eol === '\r\n' ? '\r' : ''}`);
      const newLines = Array.from({ length: count + 1 }, (_, i) => `new${i}${eol === '\r\n' ? '\r' : ''}`);
      const body = [...oldLines.map((line, i) => `-${line}\n${!finalNewline && i === oldLines.length - 1 ? '\\ No newline at end of file\n' : ''}`),
        ...newLines.map((line, i) => `+${line}\n${!finalNewline && i === newLines.length - 1 ? '\\ No newline at end of file\n' : ''}`)].join('');
      const hunks = parseUnifiedDiffHunks(`@@ -1,${count} +1,${count + 1} @@\n${body}`);
      const before = oldLines.join('\n') + (finalNewline ? '\n' : '');
      const after = newLines.join('\n') + (finalNewline ? '\n' : '');
      expect(applyHunks(before, hunks)).toEqual({ ok: true, text: after });
      expect(revertHunks(after, hunks)).toEqual({ ok: true, text: before });
    }
  });
  it('verifies inverse edits in post-text UTF-16 coordinates before restoring any text', () => {
    const edits = [{ startUtf16: 2, deleteLength: 3, insertText: 'new', originalText: 'old' },
      { startUtf16: 7, deleteLength: 0, insertText: '!', originalText: '' }];
    expect(applyInverseEdits('😀new x!', edits)).toEqual({ ok: true, text: '😀old x' });
    expect(applyInverseEdits('😀NEW x!', edits)).toEqual({ ok: false, reason: 'moved_on' });
    expect(applyInverseEdits('😀new x!', [edits[0]!, edits[0]!])).toEqual({ ok: false, reason: 'overlap' });
  });
  it('applies large whole-file hunks without depending on the JavaScript argument limit', () => {
    const count = 150_000;
    const hunks = parseUnifiedDiffHunks(`@@ -0,0 +1,${count} @@\n${'+line\n'.repeat(count)}`);
    expect(applyHunks('', hunks)).toEqual({ ok: true, text: 'line\n'.repeat(count) });
  });
  it('keeps header-looking context as content while accepting display-indented real headers', () => {
    const patch = '@@ -1,2 +1,2 @@\n @@ -30 +30 @@\n-old\n+new\n';
    const hunks = parseUnifiedDiffHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines[0]).toEqual({ kind: 'context', text: '@@ -30 +30 @@' });
    expect(revertHunks('@@ -30 +30 @@\nnew\n', hunks)).toEqual({ ok: true, text: '@@ -30 +30 @@\nold\n' });
    expect(parseUnifiedDiffHunks('  @@ -1 +1 @@\n-old\n+new\n')).toHaveLength(1);
  });
});
