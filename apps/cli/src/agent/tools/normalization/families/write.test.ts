import { describe, expect, it } from 'vitest';

import { normalizeWriteInput, normalizeWriteResult } from './write';

describe('normalizeWriteResult', () => {
  it('decodes direct and nested content text in order while preserving result shapes', () => {
    const content = [{ text: 'direct', content: { text: 'nested' } }, { content: { text: 'completed' } }];
    expect(normalizeWriteResult(content)).toEqual({ message: 'direct\nnested\ncompleted' });
    expect(normalizeWriteResult({ content, success: true })).toEqual({
      content,
      text: 'direct\nnested\ncompleted',
      success: true,
      applied: true,
    });
    expect(normalizeWriteResult([])).toEqual({ value: [] });
    expect(normalizeWriteResult([{ content: { text: '' } }])).toEqual({ value: [{ content: { text: '' } }] });
  });
});

describe('normalizeWriteInput', () => {
  it('derives file_path + content from ACP diff items[0] when missing', () => {
    const normalized = normalizeWriteInput({
      items: [{ path: '/tmp/a.txt', oldText: 'old', newText: 'new', type: 'diff' }],
    });

    expect(normalized.file_path).toBe('/tmp/a.txt');
    expect(normalized.content).toBe('new');
  });

  it('derives file_path from ACP single locations entry when missing', () => {
    const normalized = normalizeWriteInput({
      locations: [{ filePath: '/tmp/b.txt' }],
      content: 'hello',
    });

    expect(normalized.file_path).toBe('/tmp/b.txt');
  });

  it('keeps explicit file_path over item and location fallbacks', () => {
    const normalized = normalizeWriteInput({
      file_path: '/tmp/explicit.txt',
      items: [{ path: '/tmp/item.txt', newText: 'item text' }],
      locations: [{ filePath: '/tmp/location.txt' }],
      content: 'explicit text',
    });

    expect(normalized.file_path).toBe('/tmp/explicit.txt');
    expect(normalized.content).toBe('explicit text');
  });

  it('does not derive file_path from multiple location entries', () => {
    const normalized = normalizeWriteInput({
      locations: [{ filePath: '/tmp/one.txt' }, { filePath: '/tmp/two.txt' }],
      content: 'hello',
    });

    expect(normalized.file_path).toBeUndefined();
  });

  it('uses file_content when content is missing', () => {
    const normalized = normalizeWriteInput({
      filePath: '/tmp/from-file-content.txt',
      file_content: 'from-file-content',
    });

    expect(normalized.file_path).toBe('/tmp/from-file-content.txt');
    expect(normalized.content).toBe('from-file-content');
  });
});
