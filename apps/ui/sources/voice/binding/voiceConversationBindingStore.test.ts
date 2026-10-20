import { describe, expect, it } from 'vitest';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@happier-dev/protocol/voice/sessionBinding';

import {
  bindVoiceRuntimeAttemptBinding,
  createVoiceRuntimeAttemptBindingOwner,
  createVoiceSessionBindingStore,
  unbindVoiceRuntimeAttemptBindingIfOwned,
} from './voiceConversationBindingStore';

describe('createVoiceSessionBindingStore', () => {
  it('does not notify subscribers when a storage refresh has equivalent persisted bindings', () => {
    const store = createVoiceSessionBindingStore();
    const binding = {
      adapterId: 'local_conversation', controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-a',
      conversationSessionAddress: { serverId: 'server-1', sessionId: 'carrier-a' },
      transcriptMode: 'synthetic' as const, targetSessionAddress: null, updatedAt: 1,
    };
    store.getState().replacePersistedBindings([binding]);
    const admitted = store.getState();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });
    store.getState().replacePersistedBindings([{ ...binding }]);
    expect(store.getState()).toBe(admitted);
    expect(notifications).toBe(0);

    store.getState().replacePersistedBindings([binding, {
      ...binding, controlSessionId: 'voice-other', conversationSessionId: 'carrier-b',
      conversationSessionAddress: { serverId: 'server-1', sessionId: 'carrier-b' },
    }]);
    expect(notifications).toBe(1);
    expect(store.getState().persistedBindingsByConversationSessionId['carrier-a'])
      .toBe(admitted.persistedBindingsByConversationSessionId['carrier-a']);
    store.getState().replacePersistedBindings([]);
    expect(store.getState().list()).toEqual([]);
    expect(notifications).toBe(2);
    unsubscribe();
  });

  it('does not publish equivalent runtime admission or removal of an absent binding', () => {
    const store = createVoiceSessionBindingStore();
    const binding = {
      adapterId: 'local_conversation', controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-a',
      conversationSessionAddress: { serverId: 'server-1', sessionId: 'carrier-a' },
      transcriptMode: 'synthetic' as const, targetSessionAddress: null, updatedAt: 1,
    };
    store.getState().bind(binding);
    const admitted = store.getState();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });
    store.getState().bind({ ...binding });
    store.getState().unbind('absent');
    expect(store.getState()).toBe(admitted);
    expect(notifications).toBe(0);
    store.getState().bind({ ...binding, updatedAt: 2 });
    expect(store.getState().getByConversationSessionId('carrier-a')?.updatedAt).toBe(2);
    expect(notifications).toBe(1);
    store.getState().unbind('carrier-a');
    expect(store.getState().list()).toEqual([]);
    expect(notifications).toBe(2);
    unsubscribe();
  });

  it('replaces stale bindings that reuse the same control session id', () => {
    const store = createVoiceSessionBindingStore();

    store.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-a',
      conversationSessionAddress: { serverId: 'server-1', sessionId: 'carrier-a' },
      transcriptMode: 'synthetic',
      targetSessionAddress: { serverId: 'server-1', sessionId: 's1' },
      updatedAt: 1,
    });

    store.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-b',
      conversationSessionAddress: { serverId: 'server-1', sessionId: 'carrier-b' },
      transcriptMode: 'synthetic',
      targetSessionAddress: { serverId: 'server-1', sessionId: 's2' },
      updatedAt: 2,
    });

    expect(store.getState().getByConversationSessionId('carrier-a')).toBeNull();
    expect(store.getState().getByConversationSessionId('carrier-b')).toEqual(
      expect.objectContaining({
        controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-b',
        targetSessionAddress: { serverId: 'server-1', sessionId: 's2' },
      }),
    );
    expect(store.getState().list()).toHaveLength(1);
  });

  it('returns the newest matching binding from getByControlSessionId when several share a control session id', async () => {
    const store = createVoiceSessionBindingStore();
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');
    const { syncPersistedVoiceConversationBindings } = await import('./voiceConversationBindingStore');

    // Two persisted bindings on distinct conversation sessions share one control
    // session id (e.g. the global voice control session bound to two conversations
    // across reconnects). The newest by updatedAt must win.
    syncPersistedVoiceConversationBindings({
      store,
      state: {
        sessions: {
          'carrier-old': createSessionFixture({
            id: 'carrier-old',
            serverId: 'server-old',
            metadata: writeVoiceConversationBindingMetadata(
              { ...createSessionFixture().metadata!, ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
              {
                adapterId: 'local_conversation',
                controlSessionId: '__voice_agent__',
                conversationSessionId: 'carrier-old',
                conversationSessionAddress: { serverId: 'server-old', sessionId: 'carrier-old' },
                transcriptMode: 'synthetic',
                targetSessionAddress: { serverId: 'server-old', sessionId: 's-old' },
                updatedAt: 100,
              },
            ),
          }),
          'carrier-new': createSessionFixture({
            id: 'carrier-new',
            serverId: 'server-new',
            metadata: writeVoiceConversationBindingMetadata(
              { ...createSessionFixture().metadata!, ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
              {
                adapterId: 'local_conversation',
                controlSessionId: '__voice_agent__',
                conversationSessionId: 'carrier-new',
                conversationSessionAddress: { serverId: 'server-new', sessionId: 'carrier-new' },
                transcriptMode: 'synthetic',
                targetSessionAddress: { serverId: 'server-new', sessionId: 's-new' },
                updatedAt: 200,
              },
            ),
          }),
        },
      },
    });

    expect(store.getState().getByControlSessionId('__voice_agent__')).toEqual(
      expect.objectContaining({
        conversationSessionId: 'carrier-new',
        targetSessionAddress: { serverId: 'server-new', sessionId: 's-new' },
        updatedAt: 200,
      }),
    );
  });

  it('canonicalizes binding ids when storing and looking up bindings', () => {
    const store = createVoiceSessionBindingStore();

    store.getState().bind({
      adapterId: '  local_conversation  ',
      controlSessionId: '  voice-global  ',
      conversationSessionId: '  carrier-a  ',
      conversationSessionAddress: { serverId: '  server-1  ', sessionId: '  carrier-a  ' },
      transcriptMode: 'synthetic',
      targetSessionAddress: { serverId: '  server-1  ', sessionId: '  s1  ' },
      updatedAt: 1,
    });

    expect(store.getState().getByConversationSessionId('carrier-a')).toEqual(
      expect.objectContaining({
        adapterId: 'local_conversation',
        controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-a',
        targetSessionAddress: { serverId: 'server-1', sessionId: 's1' },
      }),
    );
    expect(store.getState().getByControlSessionId('voice-global')).toEqual(
      expect.objectContaining({
        adapterId: 'local_conversation',
        controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-a',
        targetSessionAddress: { serverId: 'server-1', sessionId: 's1' },
      }),
    );
  });

  it('syncs persisted bindings from direct session metadata when lookup metadata does not carry the voice binding', async () => {
    const store = createVoiceSessionBindingStore();
    const { syncPersistedVoiceConversationBindings } = await import('./voiceConversationBindingStore');
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');

    syncPersistedVoiceConversationBindings({
      store,
      state: {
        sessions: {
          'carrier-s1': createSessionFixture({
            id: 'carrier-s1',
            serverId: 'srv-1',
            metadata: writeVoiceConversationBindingMetadata(
              { ...createSessionFixture().metadata!, ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
              {
                adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                controlSessionId: '__voice_agent__',
                conversationSessionId: 'carrier-s1',
                conversationSessionAddress: { serverId: 'srv-1', sessionId: 'carrier-s1' },
                transcriptMode: 'synthetic',
                targetSessionAddress: { serverId: 'srv-1', sessionId: 'root-s1' },
                updatedAt: 10,
              },
            ),
          }),
        },
        sessionListIndexByServerId: {
          'srv-1': [{ type: 'session', sessionId: 'carrier-s1', serverId: 'srv-1', serverName: 'Primary' }],
        },
        sessionListRowsByServerId: {
          'srv-1': {
            'carrier-s1': createSessionListRenderableSessionFixture({
              id: 'carrier-s1',
              metadata: { ...createSessionFixture().metadata!, summaryText: 'Cached shell metadata only', path: '/tmp/carrier-s1' },
            }),
          },
        },
        ordinarySessionListMembershipByServerId: { 'srv-1': ['carrier-s1'] },
      },
    });

    expect(
      store.getState().getByControlSessionId('__voice_agent__'),
    ).toEqual(
      expect.objectContaining({
        adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        conversationSessionId: 'carrier-s1',
        targetSessionAddress: { serverId: 'srv-1', sessionId: 'root-s1' },
      }),
    );
  });

  it('syncs a layout-v1 binding only from the owner metadata view', async () => {
    const store = createVoiceSessionBindingStore();
    const { syncPersistedVoiceConversationBindings } = await import('./voiceConversationBindingStore');
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');
    const binding = {
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'carrier-owner',
      conversationSessionAddress: { serverId: 'srv-owner', sessionId: 'carrier-owner' },
      transcriptMode: 'native_session' as const,
      targetSessionAddress: { serverId: 'srv-owner', sessionId: 'owner-target' },
      updatedAt: 20,
    };

    const session = createSessionFixture({
      id: 'carrier-owner',
      serverId: 'srv-owner',
      metadataLayoutVersion: 1,
      metadata: writeVoiceConversationBindingMetadata(
        { ...createSessionFixture().metadata!, v: 1, ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
        { ...binding, targetSessionAddress: { serverId: 'srv-owner', sessionId: 'shared-private-lookalike' } },
      ),
      ownerMetadataView: writeVoiceConversationBindingMetadata(
        { ...createSessionFixture().metadata!, ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
        binding,
      ),
    });
    const state = {
      sessions: {
        'carrier-owner': session,
      },
    };
    syncPersistedVoiceConversationBindings({
      store,
      state,
    });

    expect(store.getState().getByControlSessionId('__voice_agent__')?.targetSessionAddress).toEqual({
      serverId: 'srv-owner',
      sessionId: 'owner-target',
    });

    state.sessions['carrier-owner'].ownerMetadataView = null;
    syncPersistedVoiceConversationBindings({ store, state });
    expect(store.getState().getByControlSessionId('__voice_agent__')).toBeNull();
  });

  it('does not let stale direct-media cleanup unbind a same-carrier replacement with an equal timestamp', () => {
    const store = createVoiceSessionBindingStore();
    const retiredOwner = createVoiceRuntimeAttemptBindingOwner();
    const replacementOwner = createVoiceRuntimeAttemptBindingOwner();
    const binding = {
      adapterId: 'happier.voice.openai/realtime-openai',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-history-reused-carrier',
      conversationSessionAddress: { serverId: 'server-a', sessionId: 'voice-history-reused-carrier' },
      lifetime: 'runtime_attempt' as const,
      transcriptMode: 'synthetic' as const,
      targetSessionAddress: null,
      updatedAt: 42,
    };

    bindVoiceRuntimeAttemptBinding({
      store,
      owner: retiredOwner,
      binding,
    });
    bindVoiceRuntimeAttemptBinding({
      store,
      owner: replacementOwner,
      binding,
    });

    expect(unbindVoiceRuntimeAttemptBindingIfOwned({
      store,
      owner: retiredOwner,
      conversationSessionId: binding.conversationSessionId,
    })).toBe(false);
    expect(store.getState().getByConversationSessionId(
      binding.conversationSessionId,
    )).toMatchObject(binding);
    expect(unbindVoiceRuntimeAttemptBindingIfOwned({
      store,
      owner: replacementOwner,
      conversationSessionId: binding.conversationSessionId,
    })).toBe(true);
    expect(store.getState().getByConversationSessionId(
      binding.conversationSessionId,
    )).toBeNull();
  });

  it('keeps local custody over newer synced control-slot bindings and reveals discovery after exact cleanup', async () => {
    const store = createVoiceSessionBindingStore();
    const owner = createVoiceRuntimeAttemptBindingOwner();
    const { syncPersistedVoiceConversationBindings } = await import('./voiceConversationBindingStore');
    const { writeVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');
    const runtimeBinding = {
      adapterId: 'happier.voice.openai/realtime-openai',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'runtime-carrier-a',
      conversationSessionAddress: { serverId: 'server-a', sessionId: 'runtime-carrier-a' },
      lifetime: 'runtime_attempt' as const,
      transcriptMode: 'synthetic' as const,
      targetSessionAddress: null,
      updatedAt: 10,
    };

    bindVoiceRuntimeAttemptBinding({
      store,
      owner,
      binding: runtimeBinding,
    });
    const locallyAdmittedBindings = store.getState().bindingsByConversationSessionId;
    syncPersistedVoiceConversationBindings({
      store,
      state: {
        sessions: {
          'persisted-carrier-b': createSessionFixture({
            id: 'persisted-carrier-b',
            serverId: 'server-a',
            metadata: writeVoiceConversationBindingMetadata(
              { ...createSessionFixture().metadata!, ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }) },
              {
                ...runtimeBinding,
                conversationSessionId: 'persisted-carrier-b',
                conversationSessionAddress: { serverId: 'server-a', sessionId: 'persisted-carrier-b' },
                lifetime: undefined,
                updatedAt: 20,
              },
            ),
          }),
        },
      },
    });

    expect(store.getState().getByControlSessionId(runtimeBinding.controlSessionId))
      .toMatchObject({ conversationSessionId: 'runtime-carrier-a' });
    expect(store.getState().bindingsByConversationSessionId).toBe(locallyAdmittedBindings);
    expect(unbindVoiceRuntimeAttemptBindingIfOwned({
      store,
      owner,
      conversationSessionId: runtimeBinding.conversationSessionId,
    })).toBe(true);

    expect(store.getState().getByControlSessionId(runtimeBinding.controlSessionId))
      .toMatchObject({ conversationSessionId: 'persisted-carrier-b' });

    syncPersistedVoiceConversationBindings({ store, state: { sessions: {} } });

    expect(store.getState().getByConversationSessionId(
      runtimeBinding.conversationSessionId,
    )).toBeNull();
    expect(store.getState().getByControlSessionId(runtimeBinding.controlSessionId)).toBeNull();
  });
});
