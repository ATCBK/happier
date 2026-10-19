import { describe, expect, it } from 'vitest';

import { formatAgentNameListFolded } from './agentNameList';

describe('formatAgentNameListFolded', () => {
  it('writes a short list out and folds a long one to two names and a count, never "and 1 more"', () => {
    expect(formatAgentNameListFolded(['Claude', 'Codex'], 2, 'en')).toBe('Claude and Codex');
    expect(formatAgentNameListFolded(['Claude', 'Codex', 'OpenCode'], 2, 'en')).toBe('Claude, Codex, and OpenCode');
    expect(formatAgentNameListFolded(['Claude', 'Codex', 'OpenCode', 'Cursor', 'Grok'], 2, 'en')).toBe('Claude, Codex, and 3 more');
  });
});
