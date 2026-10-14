import { describe, expect, it } from 'vitest';

import { parseMarkdownBlock } from './parseMarkdownBlock';

describe('parseMarkdownBlock (tables)', () => {
  it('preserves intentionally empty cells inside pipe-delimited rows', () => {
    const markdown = [
      '| A | | C |',
      '| --- | --- | --- |',
      '| 1 | | 3 |',
      '',
    ].join('\n');

    const blocks = parseMarkdownBlock(markdown);
    const table = blocks.find((b) => b.type === 'table');
    expect(table).toBeTruthy();
    expect(table).toMatchObject({
      type: 'table',
      headers: ['A', '', 'C'],
      rows: [['1', '', '3']],
    });
  });

  it('treats escaped pipes as cell content while preserving preceding backslashes', () => {
    const markdown = [
      '| Pattern \\| name | Meaning |',
      '| --- | --- |',
      '| a \\| b | either |',
      '| `a \\\\| b` | backslash and pipe |',
      '',
    ].join('\n');

    expect(parseMarkdownBlock(markdown).find((block) => block.type === 'table')).toMatchObject({
      type: 'table',
      headers: ['Pattern | name', 'Meaning'],
      rows: [['a | b', 'either'], ['`a \\| b`', 'backslash and pipe']],
    });
  });

  it('pads short rows to match the header column count', () => {
    const markdown = [
      '| A | B | C |',
      '| --- | --- | --- |',
      '| 1 | 2 |',
      '',
    ].join('\n');

    const blocks = parseMarkdownBlock(markdown);
    const table = blocks.find((b) => b.type === 'table');
    expect(table).toBeTruthy();
    expect(table).toMatchObject({
      type: 'table',
      headers: ['A', 'B', 'C'],
      rows: [['1', '2', '']],
    });
  });

  it('captures GitHub table column alignment from the separator row', () => {
    const markdown = [
      '| Left | Center | Right | Default |',
      '| :--- | :---: | ---: | --- |',
      '| Alpha | Bravo | Charlie | Delta |',
      '',
    ].join('\n');

    const blocks = parseMarkdownBlock(markdown);
    const table = blocks.find((b) => b.type === 'table');
    expect(table).toBeTruthy();
    expect(table).toMatchObject({
      type: 'table',
      alignments: ['left', 'center', 'right', 'default'],
    });
  });
});
