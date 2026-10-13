import { beforeEach, describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { resolveVoiceAgentInitialContexts } from './resolveVoiceAgentInitialContexts';

describe('resolveVoiceAgentInitialContexts', () => {
  beforeEach(() => {
    const serverId = getActiveServerSnapshot().serverId;
    storage.setState({ settings: settingsParse({ voice: { privacy: { shareSessionSummary: true } } }),
      sessions: {
        'voice-carrier': createSessionFixture({ id: 'voice-carrier', serverId }),
        'shared-session': createSessionFixture({ id: 'shared-session', serverId,
          metadata: { ...createSessionFixture().metadata, summary: { text: 'Active Home private summary', updatedAt: 1 } } }),
      },
      sessionMessages: {},
      sessionListRowsByServerId: { 'home-b': { 'shared-session': createSessionFixture({ id: 'shared-session',
        metadata: { ...createSessionFixture().metadata, summaryText: 'Qualified Home B summary' } }) } },
      ordinarySessionListMembershipByServerId: { 'home-b': ['shared-session'] },
      sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {},
    });
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
    useVoiceTargetStore.getState().setLastFocusedSessionAddress(null);
  });

  it('preserves the qualified target address when composing deferred context', () => {
    const targetSessionAddress = { serverId: 'home-b', sessionId: 'shared-session' } as const;

    const result = resolveVoiceAgentInitialContexts('voice-carrier', { targetSessionAddress });
    expect(result.bootstrapInitialContext).toContain('THIS IS AN ACTIVE SESSION:');
    expect(result.bootstrapInitialContext).not.toContain('Qualified Home B summary');
    expect(result.deferredTargetSessionContext).toContain('THIS IS THE CURRENT TARGET SESSION:');
    expect(result.deferredTargetSessionContext).toContain('Qualified Home B summary');
    expect(result.deferredTargetSessionContext).not.toContain('Active Home private summary');
  });
});
