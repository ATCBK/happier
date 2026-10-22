import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
  }),
);

import { resolveConversationHitSnippet, trimConversationHitLead } from './ConversationHitSummary';

describe('trimConversationHitLead', () => {
  const long =
    '… fails with a non-retryable agent_error, and the Claude Titles listing returns 0 sessions. Before this reload, silver meadow found 9 hits, so one of the fixes broke it.';

  it('starts a long snippet a few whole words before its first match, so a two-line clamp keeps the match', () => {
    const shown = trimConversationHitLead(long, 'silver meadow');
    expect(shown.startsWith('…')).toBe(true);
    expect(shown.indexOf('silver meadow')).toBeLessThanOrEqual(26);
    expect(shown.endsWith(long.slice(-30))).toBe(true);
    // Whole words only: the cut never lands inside one.
    expect(shown.slice(1)).toMatch(/^[^\s]/);
    expect(long).toContain(shown.slice(1));
  });

  it('leaves a snippet whose match is already near the start, and one with no literal match, untouched', () => {
    expect(trimConversationHitLead('…the flaky e2e is the settings sheet', 'flaky e2e')).toBe(
      '…the flaky e2e is the settings sheet',
    );
    expect(trimConversationHitLead(long, 'no such phrase')).toBe(long);
    expect(trimConversationHitLead(long, undefined)).toBe(long);
  });
});

describe('resolveConversationHitSnippet', () => {
  it('retains pre-extraction ordered-list and literal-role preview semantics', () => {
    expect(resolveConversationHitSnippet({ title: 'Other conversation',
      snippet: '1. First\n2. **Second**\nUser: keep this role label\nAssistant: keep this one too', query: undefined }))
      .toBe('First Second User: keep this role label Assistant: keep this one too');
  });

  it('keeps numbered search matches while flattening role-labelled message Markdown', () => {
    expect(resolveConversationHitSnippet({ title: 'Other conversation',
      snippet: 'User: # First\n554. **Second**\nAssistant: ## Keep issue #42 and C# literal\n`User: # literal`', query: '554' }))
      .toBe('First 554. Second Keep issue #42 and C# literal User: # literal');
  });

  const title = 'Reply with exactly: amber orchard, silver meadow. Do not use tools, read files, run commands, or change anything.';

  it('drops a snippet that is a clip of the title, which then carries the match', () => {
    expect(resolveConversationHitSnippet({
      title, snippet: '…amber orchard, silver meadow. Do not use tools, read files, run commands, or change anything.', query: 'silver meadow',
    })).toBeNull();
  });

  it('keeps a snippet from other text, and one whose match the title does not show within its clamp', () => {
    expect(resolveConversationHitSnippet({ title, snippet: '…the assistant answered silver meadow', query: 'silver meadow' }))
      .toBe('…the assistant answered silver meadow');
    const farTitle = `Write 900 numbered lines of detailed orchard and meadow observations, beginning each line with amber orchard or silver meadow`;
    expect(resolveConversationHitSnippet({ title: farTitle, snippet: '…each line with amber orchard or silver meadow', query: 'silver meadow' }))
      .toBe('…each line with amber orchard or silver meadow');
    expect(resolveConversationHitSnippet({ title, snippet: '…silver meadow', query: undefined })).toBe('…silver meadow');
  });
});
