import { describe, expect, it } from 'vitest';
import { buildHappierBaseSystemPromptV1 } from '../../prompts/systemPromptBaseV1.js';
import { renderSessionInputContextPromptV1, renderSessionInputContextBlockV1 } from '../messages/sessionInputPromptContextV1.js';
import { createExternalSessionContentMatchSnippet, findExternalSessionContentMatchRange } from './contentSearchMatch.js';

describe('native conversation display snippets', () => {
  it('excludes injected context and centres a compact display window on the real match', () => {
    const text = renderSessionInputContextPromptV1({
      provenanceBlock: renderSessionInputContextBlockV1({ provenance: { v: 1, kind: 'legacyUnknown' } }),
      transformedUserText: `${buildHappierBaseSystemPromptV1()}\n\n${'Earlier context.\n'.repeat(80)}Fix silver meadow before shipping.`,
    });
    const snippet = createExternalSessionContentMatchSnippet(text, 'silver meadow')!;
    const range = findExternalSessionContentMatchRange(snippet, 'silver meadow')!;
    expect(snippet).toContain('silver meadow');
    expect(snippet).not.toMatch(/happier_input_context|Session title|\n/);
    expect(snippet.slice(range.start, range.end)).toBe('silver meadow');
    expect(createExternalSessionContentMatchSnippet(text, 'source_kind')).toContain('source_kind');
    expect(createExternalSessionContentMatchSnippet(text, 'change_title')).toContain('change_title');
  });

  it('keeps Unicode coordinates and user-authored lookalike headings intact', () => {
    const snippet = createExternalSessionContentMatchSnippet('İ 🐈 please review # Session title in the documentation', 'review')!;
    const range = findExternalSessionContentMatchRange(snippet, 'review')!;
    expect(snippet.slice(range.start, range.end)).toBe('review');
    expect(snippet).toContain('# Session title');
  });
});
