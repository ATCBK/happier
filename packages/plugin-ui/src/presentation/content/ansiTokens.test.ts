import { describe, expect, it } from 'vitest';

import { tokenizeAnsiText } from '../../ansi.js';

describe('portable ANSI text tokens', () => {
  it('carries SGR and incomplete sequences across chunks with plain UTF-16 offsets', () => {
    const first = tokenizeAnsiText('A\u001b[1;38;2;10;20;');
    const second = tokenizeAnsiText('30m😀red\u001b[22;39mZ', first.state);
    expect(first.plainText + second.plainText).toBe('A😀redZ');
    expect(second.tokens).toEqual([
      { text: '😀red', start: 1, end: 6, style: { bold: true, foreground: '#0a141e' } },
      { text: 'Z', start: 6, end: 7, style: {} },
    ]);
  });

  it('supports 16/256 colors, reset and read-only style flags while discarding terminal effects', () => {
    const result = tokenizeAnsiText('\u001b[31;44;3;4;7;9mred\u001b[0m plain\u001b[38;5;196m!\u001b[2J');
    expect(result.plainText).toBe('red plain!');
    expect(result.tokens[0]?.style).toEqual({ foreground: '#800000', background: '#000080', italic: true, underline: true, inverse: true, strikethrough: true });
    expect(result.tokens[1]?.style).toEqual({});
    expect(result.tokens[2]?.style.foreground).toBe('#ff0000');
  });

  it('never exposes OSC clipboard, title or hyperlink controls as text or executable markup', () => {
    const first = tokenizeAnsiText('before\u001b]52;c;secret');
    const second = tokenizeAnsiText('\u0007\u001b]8;;javascript:alert(1)\u001b\\<b>link</b>\u001b]8;;\u001b\\after', first.state);
    expect(first.plainText + second.plainText).toBe('before<b>link</b>after');
    expect(second.state.pending).toBe('');
  });
});
