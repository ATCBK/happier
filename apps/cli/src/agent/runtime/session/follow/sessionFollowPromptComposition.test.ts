import { describe, expect, it, vi } from 'vitest';

import {
  deriveSessionFollowWakeEventLocalIdV1,
  renderSessionInputContextPromptV1,
} from '@happier-dev/protocol';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createSessionFollowContextReconciler } from './sessionFollowContextReconciler';

const frontier = {
  transcriptSeq: 2,
  readyEventSeq: 0,
  agentStateVersion: 0,
  turn: null,
};

describe('Session Follow prompt composition through the canonical owner', () => {
  it('prepares a context-only wake only for authoritative human source input', async () => {
    const acknowledgeSessionFollow = vi.fn().mockResolvedValue({ ok: true });
    const observation = {
      sourceSessionId: 'source', destinationSessionId: 'destination', policy: { preset: 'custom' as const, events: { person_wrote: { delivery: 'interrupt' as const }, message: { delivery: 'quiet' as const } } },
      delivered: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null }, observed: frontier,
    };
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '7',
        currentSourceSessionIds: ['source'], observations: [observation],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const reconciler = createSessionFollowContextReconciler({
      session, maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: async () => ({
        v: 1, kind: 'session_follow_update', edge: { sourceSessionId: 'source', destinationSessionId: 'destination' },
        reason: 'source_changed', deliveryIntent: 'context_only', observed: frontier,
        awareness: { v: 1, sessionId: 'source', lifecycle: 'ready', runtime: 'idle', freshness: 'live', operational: { primary: 'ready', reasons: ['ready'] }, encryption: 'plain', availability: 'complete' },
        recentMessages: [{ messageId: 'human-2', seq: 2, text: 'Review this', provenance: { v: 1, kind: 'happierApp', actor: { kind: 'owner' } } }],
        truncated: false,
      }),
    });
    const prepared = await reconciler({ signal: new AbortController().signal, deliveryIntent: 'wake' });
    expect(prepared?.updates[0]).toMatchObject({ reason: 'human_changed_source', deliveryIntent: 'wake' });
    const wakeEventLocalId = deriveSessionFollowWakeEventLocalIdV1({
      destinationSessionId: 'destination',
      publisherGeneration: '7',
      observations: [{ policy: observation.policy, sourceSessionId: 'source', expected: observation.delivered, consumed: frontier }],
    });
    expect(prepared?.wakeEventLocalId).toBe(wakeEventLocalId);
    prepared?.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: wakeEventLocalId });
    await Promise.resolve();
    expect(acknowledgeSessionFollow).toHaveBeenCalledWith(expect.objectContaining({
      acceptance: {
        kind: 'context_only_wake',
        eventLocalId: wakeEventLocalId,
        observations: [{ policy: observation.policy, sourceSessionId: 'source', relation: 'follower', expected: observation.delivered, consumed: frontier }],
      },
    }));
  });

  it('reaches the provider prompt and only acknowledges after provider acceptance', async () => {
    const acknowledgeSessionFollow = vi.fn().mockResolvedValue({
      ok: true, v: 1, destinationSessionId: 'destination', sourceSessionId: 'source', delivered: frontier,
    });
    const observation = {
      sourceSessionId: 'source', destinationSessionId: 'destination',
      delivered: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null },
      observed: frontier,
      policy: { preset: 'quiet' as const },
    };
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '7',
        observations: [observation],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;

    const reconciler = createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: async ({ observation }) => ({
        v: 1,
        kind: 'session_follow_update' as const,
        edge: {
          sourceSessionId: observation.sourceSessionId,
          destinationSessionId: observation.destinationSessionId,
        },
        reason: 'source_changed' as const,
        deliveryIntent: 'context_only' as const,
        observed: observation.observed,
        awareness: {
          v: 1,
          sessionId: observation.sourceSessionId,
          title: 'Source title',
          lifecycle: 'ready' as const,
          runtime: 'idle' as const,
          freshness: 'live' as const,
          operational: { primary: 'ready' as const, reasons: ['ready' as const] },
          encryption: 'plain' as const,
          availability: 'complete' as const,
        },
        recentMessages: [{ messageId: 'seq:2', seq: 2, text: 'Please review', provenance: null }],
        truncated: false,
      }),
    });

    const prepared = await reconciler({ signal: new AbortController().signal });
    expect(prepared).not.toBeNull();
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();

    const prompt = renderSessionInputContextPromptV1({
      provenanceBlock: '',
      sessionFollowUpdates: prepared!.updates,
      transformedUserText: 'ACTUAL_INPUT',
    });
    expect(prompt).toContain('<session_follow>');
    expect(prompt).toContain('Please review');
    expect(prompt.endsWith('ACTUAL_INPUT')).toBe(true);

    prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: 2 });
    await Promise.resolve();
    expect(acknowledgeSessionFollow).toHaveBeenCalledWith(expect.objectContaining({ policy: observation.policy,
      sourceSessionId: 'source',
      expected: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null },
      consumed: frontier,
      acceptance: { kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: 2 },
    }));
  });
});
