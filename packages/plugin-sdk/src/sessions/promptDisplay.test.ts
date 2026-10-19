import { describe, expect, it } from 'vitest';
import { createExternalSessionContentMatchSnippet, readSessionInputPromptUserTextV1, runWithSessionInputPromptUserTextReader } from './promptDisplay.js';
import { readSessionInputPromptUserTextV1 as readBaseUserText } from '@happier-dev/protocol/prompts/systemPromptBaseV1';

describe('native prompt display binding', () => {
  it('keeps simultaneous Agent catalog readers local without losing hidden input from search', async () => {
    const read = (block: string) => async () => {
      await Promise.resolve();
      return [readSessionInputPromptUserTextV1(`${block}\n\nActual user request`),
        createExternalSessionContentMatchSnippet(`${block}\n\nActual user request`, block)];
    };
    expect(await Promise.all(['Agent A guidance', 'Agent B guidance'].map(block =>
      runWithSessionInputPromptUserTextReader(text => readBaseUserText(text, [block]), read(block)),
    ))).toEqual([['Actual user request', 'Agent A guidance Actual user request'], ['Actual user request', 'Agent B guidance Actual user request']]);
    expect(readSessionInputPromptUserTextV1('Agent A guidance\n\nActual user request'))
      .toBe('Agent A guidance\n\nActual user request');
  });
});
