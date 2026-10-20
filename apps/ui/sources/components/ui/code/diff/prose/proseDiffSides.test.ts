import { describe, expect, it } from 'vitest';

import { buildCodeLinesFromTextDiff } from '@/components/ui/code/model/buildCodeLinesFromTextDiff';
import { buildProseDiffSides } from './proseDiffSides';

const sides = (oldText: string, newText: string, contextLines = 1) =>
  buildProseDiffSides(buildCodeLinesFromTextDiff({ oldText, newText, contextLines }));

describe('prose diff sides', () => {
  it('gives each side its own lines and numbers, marking only what that side changed', () => {
    const { old, new: next } = sides('a\nwarn 2 GB\nc\n', 'a\nwarn 1 GB\nadd one\nc\n');
    expect(old.map((line) => [line.kind, line.number, line.text])).toEqual([
      ['same', 1, 'a'], ['changed', 2, 'warn 2 GB'], ['same', 3, 'c'],
    ]);
    expect(next.map((line) => [line.kind, line.number, line.text])).toEqual([
      ['same', 1, 'a'], ['changed', 2, 'warn 1 GB'], ['changed', 3, 'add one'], ['same', 4, 'c'],
    ]);
  });

  it('separates distant changes with one gap on both sides, never a hunk header', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
    const after = ['1x', '2', '3', '4', '5', '6', '7', '8x'].join('\n');
    const { old, new: next } = sides(before, after);
    expect(old.map((line) => line.kind)).toEqual(['changed', 'same', 'gap', 'same', 'changed']);
    expect(next.map((line) => line.kind)).toEqual(['changed', 'same', 'gap', 'same', 'changed']);
    expect(old.some((line) => line.text.startsWith('@@'))).toBe(false);
  });

  it('puts a gap only between two lines a side shows, never at its start or end', () => {
    const { old, new: next } = sides('Escalate if more than one row.', 'Escalate, with the ID, if more than one row.', 0);
    expect(old.map((line) => line.kind)).toEqual(['changed']);
    expect(next.map((line) => line.kind)).toEqual(['changed']);
  });

  it('marks nothing changed when the two texts are the same', () => {
    const same = sides('same\nlines\n', 'same\nlines\n');
    expect([...same.old, ...same.new].some((line) => line.kind === 'changed')).toBe(false);
  });
});
