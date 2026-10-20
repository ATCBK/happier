import { describe, expect, it } from 'vitest';

import { toSpeechText } from './speechText';

describe('toSpeechText', () => {
  it('omits fenced code blocks and keeps the surrounding prose', () => {
    expect(toSpeechText('Run this:\n```ts\nconst a = 1;\n```\nThen restart.')).toBe('Run this:\nThen restart.');
  });

  it('turns markdown emphasis, headings, lists, quotes, and inline code into plain words', () => {
    expect(toSpeechText('## Summary\n- **Fixed** the `parser` bug\n> _really_ fixed')).toBe(
      'Summary\nFixed the parser bug\nreally fixed',
    );
  });

  it('keeps link text and drops link targets', () => {
    expect(toSpeechText('See [the docs](https://example.com/a/b) and ![diagram](x.png).')).toBe('See the docs and diagram.');
  });

  it('reads bare URLs as their domain', () => {
    expect(toSpeechText('Open https://www.github.com/happier-dev/happier/pull/1 now.')).toBe('Open github.com now.');
  });

  it('does not alter snake_case identifiers or arithmetic', () => {
    expect(toSpeechText('Set max_retry_count to 2 * 3.')).toBe('Set max_retry_count to 2 * 3.');
  });

  it('returns an empty string when the text is only code', () => {
    expect(toSpeechText('```\nls -la\n```')).toBe('');
  });

  it('omits tilde fences too', () => {
    expect(toSpeechText('Before.\n~~~py\nprint(1)\n~~~\nAfter.')).toBe('Before.\nAfter.');
  });

  it('only closes a fence with a matching marker of at least the same length', () => {
    const text = 'Example:\n````md\n```ts\nconst a = 1;\n```\n````\nThat is all.';
    expect(toSpeechText(text)).toBe('Example:\nThat is all.');
  });

  it('drops spaced horizontal rules instead of reading them as list items', () => {
    expect(toSpeechText('First part.\n- - -\nSecond part.')).toBe('First part.\nSecond part.');
  });
});
