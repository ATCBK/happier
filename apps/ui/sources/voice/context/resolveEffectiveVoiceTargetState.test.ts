import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

installDisconnectedServerSocketBoundary();
const { createStandaloneVoicePolicyHarness, prepareStandaloneVoicePolicyHarness } = await import('@/dev/testkit/harness/standaloneVoicePolicyHarness');
const { createRetainedVoiceAgentRpcBoundary } = await import('@/dev/testkit/harness/voiceAgentRpcBoundary');
await prepareStandaloneVoicePolicyHarness();

describe('resolveEffectiveVoiceTargetState', () => {
  it('treats malformed attempt-local live-context state as empty instead of throwing', async () => {
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    const { resolveEffectiveVoiceTargetState } = await import('./resolveEffectiveVoiceTargetState');

    // Invoke the runtime boundary with malformed data without weakening the store type.
    Reflect.apply(useVoiceTargetStore.setState, undefined, [{
      scope: 'global',
      primaryActionSessionAddress: null,
      voiceLiveContextSessionAddresses: null,
      lastFocusedSessionAddress: null,
    }]);

    expect(
      resolveEffectiveVoiceTargetState({ serverId: 'server-a', sessionId: 's1' }, {
        targetSessionAddress: { serverId: 'server-a', sessionId: 's1' },
      }),
    ).toEqual({
      primaryActionSessionAddress: { serverId: 'server-a', sessionId: 's1' },
      voiceLiveContextSessionAddresses: [{ serverId: 'server-a', sessionId: 's1' }],
    });
  });

  it('leaves the existing target state untouched when no canonical local-agent binding exists', async () => {
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    voiceSessionBindingStore.setState({
      bindingsByConversationSessionId: {},
      runtimeBindingsByConversationSessionId: {},
      persistedBindingsByConversationSessionId: {},
    });
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    const { resolveEffectiveVoiceTargetState } = await import('./resolveEffectiveVoiceTargetState');

    useVoiceTargetStore.setState({
      scope: 'global',
      primaryActionSessionAddress: { serverId: 'server-a', sessionId: 'existing-session' },
      voiceLiveContextSessionAddresses: [{ serverId: 'server-a', sessionId: 'existing-session' }],
      lastFocusedSessionAddress: null,
    });

    expect(resolveEffectiveVoiceTargetState('s1')).toEqual({
      primaryActionSessionAddress: { serverId: 'server-a', sessionId: 'existing-session' },
      voiceLiveContextSessionAddresses: [{ serverId: 'server-a', sessionId: 'existing-session' }],
    });
  });

  it('resolves the target of a real globally active local Agent', async () => {
    const daemon = await createRetainedVoiceAgentRpcBoundary();
    const fixture = await createStandaloneVoicePolicyHarness({ mode: 'off',
      existingSession: { id: 'voice-context-hidden', active: true, activeAt: Date.now(), metadata: {
        path: '/voice', host: 'voice.test', flavor: 'claude',
        ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
        agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
      } },
      dispatch: daemon.dispatch,
    });
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
    const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
    const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
    const { resolveEffectiveVoiceTargetState } = await import('./resolveEffectiveVoiceTargetState');
    const serverId = getActiveServerSnapshot().serverId;
    const targetSessionAddress = { serverId, sessionId: 'target-session' };
    let activation: Awaited<ReturnType<typeof fixture.activateLocalAgent>> | undefined;
    try {
      activation = await fixture.activateLocalAgent();
      expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
      voiceSessionBindingStore.getState().bind({ ...activation.binding, targetSessionAddress });
      useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
      useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
      expect(resolveEffectiveVoiceTargetState(targetSessionAddress)).toEqual({
        primaryActionSessionAddress: targetSessionAddress,
        voiceLiveContextSessionAddresses: [targetSessionAddress],
      });
    } finally {
      await activation?.dispose();
      await fixture.dispose();
    }
  });
});
