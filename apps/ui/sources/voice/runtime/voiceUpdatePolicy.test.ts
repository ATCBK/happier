import { describe, expect, it } from 'vitest';

import { readSessionIncludedInVoiceFromState, resolveVoiceSessionUpdatePolicy } from '@/voice/runtime/voiceUpdatePolicy';

describe('voiceUpdatePolicy', () => {
  it('reads synchronized Account Follow state from the exact Home list projection after reload', () => {
    const state = {
      sessionListRowsByServerId: {
        'home-a': { same: { viewer: { follow: { includeInVoice: true } } } },
        'home-b': { same: { viewer: { follow: { includeInVoice: false } } } },
      },
    };

    expect(readSessionIncludedInVoiceFromState(state, { serverId: 'home-a', sessionId: 'same' })).toBe(true);
    expect(readSessionIncludedInVoiceFromState(state, { serverId: 'home-b', sessionId: 'same' })).toBe(false);
  });

  it('treats canonical Account Follow Include in Voice as activeSession policy level', () => {
    const policy = resolveVoiceSessionUpdatePolicy({
      sessionId: 's1',
      includeInVoice: true,
      settings: {
        voice: {
          ui: {
            updates: {
              activeSession: 'snippets',
              otherSessions: 'none',
              snippetsMaxMessages: 5,
              includeUserMessagesInSnippets: true,
              otherSessionsSnippetsMode: 'never',
            },
          },
        },
      },
    });

    expect(policy.isIncludedInVoice).toBe(true);
    expect(policy.level).toBe('snippets');
    expect(policy.snippetsMaxMessages).toBe(5);
    expect(policy.includeUserMessagesInSnippets).toBe(true);
  });

  it('downgrades otherSessions snippets to summaries unless otherSessionsSnippetsMode is auto', () => {
    const policy = resolveVoiceSessionUpdatePolicy({
      sessionId: 's2',
      includeInVoice: false,
      settings: {
        voice: {
          ui: {
            updates: {
              activeSession: 'none',
              otherSessions: 'snippets',
              otherSessionsSnippetsMode: 'on_demand_only',
            },
          },
        },
      },
    });

    expect(policy.isIncludedInVoice).toBe(false);
    expect(policy.level).toBe('summaries');
  });

  it('allows otherSessions snippets when otherSessionsSnippetsMode is auto', () => {
    const policy = resolveVoiceSessionUpdatePolicy({
      sessionId: 's2',
      includeInVoice: false,
      settings: {
        voice: {
          ui: {
            updates: {
              otherSessions: 'snippets',
              otherSessionsSnippetsMode: 'auto',
            },
          },
        },
      },
    });

    expect(policy.isIncludedInVoice).toBe(false);
    expect(policy.level).toBe('snippets');
  });

  it('does not let a stale compatibility target cache elevate disclosure', () => {
    const policy = resolveVoiceSessionUpdatePolicy({
      sessionId: 'same',
      sessionAddress: { serverId: 'server-b', sessionId: 'same' },
      includeInVoice: false,
      settings: {
        voice: {
          ui: {
            updates: {
              activeSession: 'none',
              otherSessions: 'activity',
            },
          },
        },
      },
    });

    expect(policy.isIncludedInVoice).toBe(false);
    expect(policy.level).toBe('activity');
  });

  it('treats absent synchronized Follow state as not included', () => {
    const policy = resolveVoiceSessionUpdatePolicy({
      sessionId: 's2',
      includeInVoice: undefined,
      settings: {
        voice: {
          ui: {
            updates: {
              activeSession: 'none',
              otherSessions: 'snippets',
              otherSessionsSnippetsMode: 'auto',
            },
          },
        },
      },
    });

    expect(policy.isIncludedInVoice).toBe(false);
    expect(policy.level).toBe('snippets');
  });
});
