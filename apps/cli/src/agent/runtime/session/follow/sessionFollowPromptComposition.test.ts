import { describe, expect, it, vi } from 'vitest';
import { renderSessionInputContextPromptV1 } from '@happier-dev/protocol';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { SessionFollowSourceProjectionResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createSessionFollowContextReconciler } from './sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator } from './sessionFollowSourceHydrator';
import { createSessionFollowSourceMaterialResolver } from './sessionFollowSourceMaterialResolver';

describe('Session Follow prompt composition through the canonical owner', () => {
  it.each(['goal_changed', 'message'] as const)('composes an admitted %s original and ACKs only its exact accepted input', async kind => {
    const delivered = { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    const observed = { ...delivered, transcriptSeq: 1 };
    const localInputId = 'admitted-original';
    const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: kind === 'goal_changed' ? 'wake' : 'next_turn',
      original: { sourceSessionId: 'source', sourceMessage: { localId: 'source-original', seq: 1 } }, event: { kind } });
    const acknowledgeSessionFollow = vi.fn(async (_request: unknown) => ({
      ok: true as const, v: 1 as const, destinationSessionId: 'destination', sourceSessionId: 'source', delivered: observed,
    }));
    // Socket observation/ACK and source HTTP are boundaries; hydration,
    // selection, composition and acceptance custody execute their real owners.
    const session = createMutableApiSessionClientFixture({ sessionId: 'destination', overrides: {
      runSessionFollowSourceRequest: async ({ request }) => request(),
      observePendingSessionFollow: async () => ({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '7', currentSourceSessionIds: ['source'],
        observations: [{ kind: 'admitted_input', localInputId, sourceSessionId: 'source', destinationSessionId: 'destination',
          delivered, observed, delivery }],
      }),
      acknowledgeSessionFollow,
    } });
    const material = createSessionFollowSourceMaterialResolver();
    try {
      const hydrateObservation = createSessionFollowSourceHydrator({ session, credentials: { token: 'token', encryption: null },
        sourceMaterialResolver: material, deps: { fetchRunnerSourceProjection: async () =>
          SessionFollowSourceProjectionResponseV1Schema.parse({ v: 1,
            source: { id: 'source', encryptionMode: 'plain', metadata: '{}', archivedAt: null,
              createdAt: 1, updatedAt: 1, active: true, activeAt: 1, thinking: false, thinkingAt: null,
              latestTurnStatus: null, latestTurnStatusObservedAt: null, latestReadyEventSeq: null, latestReadyEventAt: null,
              meaningfulActivityAt: null, agentStateVersion: 0 },
            messages: [{ seq: 1, createdAt: 1, messageRole: 'agent', content: { t: 'plain', v: { role: 'agent',
              content: kind === 'goal_changed' ? { type: 'event', data: { type: 'goal-changed' } }
                : { type: 'codex', data: { type: 'message', message: 'Please review' } } } } }], hasMore: false,
          }),
        } });
      const reconciler = createSessionFollowContextReconciler({ session, hydrateObservation, maxFollowContextUtf8Bytes: 8192 });
      const prepared = await reconciler({ signal: new AbortController().signal,
        followDeliveries: [{ delivery, localInputId, userMessageSeq: 2 }] });
      expect(prepared?.representedFollowLocalInputIds).toEqual([localInputId]);
      expect(prepared?.wakeEventLocalId).toBeUndefined();
      expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
      const prompt = renderSessionInputContextPromptV1({ sessionFollowUpdates: prepared!.updates,
        transformedUserText: 'ACTUAL_INPUT' });
      expect(prompt).toContain('<session_follow>');
      expect(prompt).toContain(kind === 'goal_changed' ? 'goal changed' : 'Please review');
      expect(prompt.endsWith('ACTUAL_INPUT')).toBe(true);
      prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'another-input', userMessageSeq: 2 });
      expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
      prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId, userMessageSeq: 2 });
      await vi.waitFor(() => expect(acknowledgeSessionFollow).toHaveBeenCalledWith(expect.objectContaining({
        localInputId, sourceSessionId: 'source', expected: delivered, consumed: observed,
        acceptance: { kind: 'admitted_input', localInputId, userMessageSeq: 2 },
      })));
    } finally { material.dispose(); }
  });
});
