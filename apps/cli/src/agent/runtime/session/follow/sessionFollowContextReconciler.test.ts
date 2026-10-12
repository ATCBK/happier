import { describe, expect, it, vi } from 'vitest';

import {
  SessionFollowUpdateEnvelopeV1Schema,
  type SessionFollowFrontierV1,
} from '@happier-dev/protocol';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import { SocketAckError } from '@/session/transport/shared/socketAck';
import {
  createSessionFollowContextReconciler,
  type SessionFollowHydrateObservation,
} from './sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator } from './sessionFollowSourceHydrator';

const frontier = {
  transcriptSeq: 2,
  readyEventSeq: 1,
  agentStateVersion: 3,
  turn: { id: 'turn-1', status: 'completed' as const },
};

const zeroFrontier = { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null };

function envelopeFor(observation: { sourceSessionId: string; destinationSessionId: string; observed: typeof frontier }) {
  return {
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
      lifecycle: 'ready' as const,
      runtime: 'idle' as const,
      freshness: 'live' as const,
      operational: { primary: 'ready' as const, reasons: ['ready' as const] },
      encryption: 'plain' as const,
      availability: 'complete' as const,
    },
    recentMessages: [],
    truncated: false,
  };
}

describe('Session Follow context reconciler', () => {
  it('does not self-rearm the wake signal after an observe transport timeout', async () => {
    const observePendingSessionFollow = vi.fn().mockRejectedValue(new SocketAckError({
      code: 'socket_ack_timeout',
      event: 'session.follow.observe_pending',
    }));
    const prepared = await createSessionFollowContextReconciler({
      session: {
        sessionId: 'destination',
        observePendingSessionFollow,
      } as unknown as ApiSessionClient,
      hydrateObservation: vi.fn(),
    })({ signal: new AbortController().signal, maxFollowContextUtf8Bytes: 8_192, deliveryIntent: 'wake' });

    expect(prepared).toBeNull();
    expect(observePendingSessionFollow).toHaveBeenCalledOnce();
  });

  it('does not re-arm for a disconnected or otherwise non-timeout observation failure', async () => {
    const prepared = await createSessionFollowContextReconciler({
      session: {
        sessionId: 'destination',
        observePendingSessionFollow: vi.fn().mockRejectedValue(new SocketAckError({
          code: 'socket_not_connected',
          event: 'session.follow.observe_pending',
        })),
      } as unknown as ApiSessionClient,
      hydrateObservation: vi.fn(),
    })({ signal: new AbortController().signal, maxFollowContextUtf8Bytes: 8_192, deliveryIntent: 'wake' });

    expect(prepared).toBeNull();
  });

  it('does not observe or hydrate Follow sources without an evidence-backed provider allowance', async () => {
    const observePendingSessionFollow = vi.fn();
    const hydrateObservation = vi.fn();
    const prepared = await createSessionFollowContextReconciler({
      session: { sessionId: 'destination', observePendingSessionFollow } as unknown as ApiSessionClient,
      hydrateObservation,
    })({ signal: new AbortController().signal });
    expect(prepared).toBeNull();
    expect(observePendingSessionFollow).not.toHaveBeenCalled();
    expect(hydrateObservation).not.toHaveBeenCalled();
  });

  it('lets an explicit null invocation allowance fail closed over a constructor test allowance', async () => {
    const observePendingSessionFollow = vi.fn();
    const prepared = await createSessionFollowContextReconciler({
      session: { sessionId: 'destination', observePendingSessionFollow } as unknown as ApiSessionClient,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: vi.fn(),
    })({
      signal: new AbortController().signal,
      maxFollowContextUtf8Bytes: null,
    });
    expect(prepared).toBeNull();
    expect(observePendingSessionFollow).not.toHaveBeenCalled();
  });

  it('retains prepared source material from authoritative membership when no delivery delta is pending', async () => {
    const retainSources = vi.fn();
    const prepared = await createSessionFollowContextReconciler({
      session: {
        sessionId: 'destination',
        observePendingSessionFollow: vi.fn().mockResolvedValue({
          ok: true,
          v: 1,
          sessionId: 'destination',
          publisherGeneration: '4',
          currentSourceSessionIds: ['source-current'],
          observations: [],
        }),
      } as unknown as ApiSessionClient,
      hydrateObservation: vi.fn(),
      sourceMaterialController: { retainSources } as never,
    })({ signal: new AbortController().signal, maxFollowContextUtf8Bytes: 8_192 });

    expect(prepared).toBeNull();
    expect(retainSources).toHaveBeenCalledWith(['source-current']);
  });

  it('prunes restricted runtime source material even when provider capacity cannot admit Follow context', async () => {
    const retainSources = vi.fn();
    const hydrateObservation = vi.fn();
    const observePendingSessionFollow = vi.fn().mockResolvedValue({
      ok: true,
      v: 1,
      sessionId: 'destination',
      publisherGeneration: '4',
      currentSourceSessionIds: [],
      observations: [],
    });

    const prepared = await createSessionFollowContextReconciler({
      session: { sessionId: 'destination', observePendingSessionFollow } as unknown as ApiSessionClient,
      hydrateObservation,
      sourceMaterialController: { retainSources } as never,
    })({ signal: new AbortController().signal, maxFollowContextUtf8Bytes: 0 });

    expect(prepared).toBeNull();
    expect(observePendingSessionFollow).toHaveBeenCalledOnce();
    expect(retainSources).toHaveBeenCalledWith([]);
    expect(hydrateObservation).not.toHaveBeenCalled();
  });

  it('hydrates observed edges and acknowledges only after the accepted provider effect', async () => {
    const acknowledgeSessionFollow = vi.fn().mockResolvedValue({
      ok: true,
      v: 1,
      destinationSessionId: 'destination',
      sourceSessionId: 'source',
      delivered: frontier,
    });
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true,
        v: 1,
        sessionId: 'destination',
        publisherGeneration: '4',
        observations: [{
          sourceSessionId: 'source',
          destinationSessionId: 'destination',
          delivered: zeroFrontier,
          observed: frontier,
        }],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const reconciler = createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: async ({ observation }) => envelopeFor(observation as never) as never,
    });

    const prepared = await reconciler({ signal: new AbortController().signal });
    expect(prepared?.updates).toHaveLength(1);
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();

    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: 7 });
    await Promise.resolve();
    expect(acknowledgeSessionFollow).toHaveBeenCalledWith({
      sourceSessionId: 'source',
      expectedPublisherGeneration: '4',
      expected: zeroFrontier,
      observed: frontier,
      consumed: { ...frontier, transcriptSeq: 0 },
      acceptance: { kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: 7 },
    });
  });

  it('wakes only for configured direct-human ingress and ACKs the exact original observation as context-only', async () => {
    const delivered = zeroFrontier;
    const observations = [
      { sourceSessionId: 'natural-human', destinationSessionId: 'destination', delivered, observed: frontier, mode: 'next_turn' as const },
      { sourceSessionId: 'wake-agent', destinationSessionId: 'destination', delivered, observed: frontier, mode: 'wake_on_human_change' as const },
      { sourceSessionId: 'wake-event', destinationSessionId: 'destination', delivered, observed: frontier, mode: 'wake_on_human_change' as const },
      { sourceSessionId: 'wake-human', destinationSessionId: 'destination', delivered, observed: frontier, mode: 'wake_on_human_change' as const },
    ];
    const acknowledgeSessionFollow = vi.fn().mockResolvedValue({
      ok: true,
      v: 1,
      destinationSessionId: 'destination',
      sourceSessionId: 'wake-human',
      delivered: frontier,
    });
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true,
        v: 1,
        sessionId: 'destination',
        publisherGeneration: '7',
        observations,
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const hydrateObservation = vi.fn(async ({ observation }: { observation: typeof observations[number] }) => ({
      ...envelopeFor(observation),
      recentMessages: [{
        messageId: `${observation.sourceSessionId}-message`,
        seq: 2,
        text: 'source update',
        provenance: observation.sourceSessionId === 'wake-human'
          ? { v: 1 as const, kind: 'cli' as const }
          : observation.sourceSessionId === 'wake-event'
            ? null
            : { v: 1 as const, kind: 'automation' as const, automationId: 'automation', runId: 'run' },
      }],
    }));
    const prepared = await createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: hydrateObservation as never,
    })({
      signal: new AbortController().signal,
      deliveryIntent: 'wake',
    });

    expect(hydrateObservation.mock.calls.map(([input]) => input.observation.sourceSessionId)).toEqual([
      'wake-agent',
      'wake-event',
      'wake-human',
    ]);
    expect(prepared?.updates).toEqual([
      expect.objectContaining({
        edge: expect.objectContaining({ sourceSessionId: 'wake-human' }),
        reason: 'human_changed_source',
        deliveryIntent: 'wake',
      }),
    ]);
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();

    prepared?.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: 'session-follow-wake:substituted' });
    await Promise.resolve();
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
    expect(prepared?.wakeEventLocalId).toMatch(/^session-follow-wake:/u);
    prepared?.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: prepared!.wakeEventLocalId! });
    await Promise.resolve();
    expect(acknowledgeSessionFollow).toHaveBeenCalledOnce();
    expect(acknowledgeSessionFollow).toHaveBeenCalledWith({
      sourceSessionId: 'wake-human',
      expectedPublisherGeneration: '7',
      expected: delivered,
      observed: frontier,
      consumed: frontier,
      acceptance: {
        kind: 'context_only_wake',
        eventLocalId: prepared!.wakeEventLocalId!,
        observations: [{ sourceSessionId: 'wake-human', expected: delivered, consumed: frontier }],
      },
    });
  });

  it('keeps unavailable source material pending without producing an acknowledgement', async () => {
    const acknowledgeSessionFollow = vi.fn();
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '1', observations: [],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const prepared = await createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: vi.fn(),
    })({ signal: new AbortController().signal });
    expect(prepared).toBeNull();
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
  });

  it('omits observations for another destination instead of trusting caller identity', async () => {
    const acknowledgeSessionFollow = vi.fn();
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '1',
        observations: [{
          sourceSessionId: 'source',
          destinationSessionId: 'other-destination',
          delivered: zeroFrontier,
          observed: frontier,
        }],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const prepared = await createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: async ({ observation }) => envelopeFor(observation as never) as never,
    })({ signal: new AbortController().signal });
    expect(prepared).toBeNull();
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
  });

  it('never acknowledges a newer hydration frontier; only the originally observed tuple', async () => {
    const acknowledgeSessionFollow = vi.fn().mockResolvedValue({ ok: true, v: 1, destinationSessionId: 'destination', sourceSessionId: 'source', delivered: frontier });
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '2',
        observations: [{
          sourceSessionId: 'source',
          destinationSessionId: 'destination',
          delivered: zeroFrontier,
          observed: frontier,
        }],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const newer = { ...frontier, transcriptSeq: 99 };
    const prepared = await createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: async ({ observation }) => ({
        ...(envelopeFor(observation as never) as object),
        observed: newer,
      }) as never,
    })({ signal: new AbortController().signal });
    expect(prepared).toBeNull();
    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: null });
    await Promise.resolve();
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
  });

  it('keeps source_unavailable visible but unacknowledged for retry', async () => {
    const acknowledgeSessionFollow = vi.fn();
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '3',
        observations: [{
          sourceSessionId: 'source',
          destinationSessionId: 'destination',
          delivered: zeroFrontier,
          observed: frontier,
        }],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const prepared = await createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: async ({ observation }) => {
        const base = envelopeFor(observation as never) as unknown as Record<string, unknown>;
        return {
          ...base,
          reason: 'source_unavailable',
          recentMessages: [],
          awareness: { ...(base.awareness as object), title: undefined, encryption: 'locked', availability: 'locked' },
        } as never;
      },
    })({ signal: new AbortController().signal });
    expect(prepared?.updates).toHaveLength(1);
    expect(prepared?.updates[0]?.reason).toBe('source_unavailable');
    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: 1 });
    await Promise.resolve();
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
  });

  it('leaves budget-omitted sources unacknowledged while acknowledging what fit', async () => {
    const bigText = 'x'.repeat(9_000);
    const acknowledgeSessionFollow = vi.fn().mockResolvedValue({ ok: true, v: 1, destinationSessionId: 'destination', sourceSessionId: 'a', delivered: frontier });
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '5',
        observations: [
          { sourceSessionId: 'a', destinationSessionId: 'destination', delivered: zeroFrontier, observed: frontier },
          { sourceSessionId: 'b', destinationSessionId: 'destination', delivered: zeroFrontier, observed: frontier },
        ],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const prepared = await createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: async ({ observation }) => {
        const base = envelopeFor(observation as never) as unknown as Record<string, unknown>;
        const obs = observation as unknown as { sourceSessionId: string };
        return {
          ...base,
          recentMessages: [{ messageId: `seq:2`, seq: 2, text: obs.sourceSessionId === 'a' ? bigText : 'small', provenance: null }],
        } as never;
      },
    })({ signal: new AbortController().signal });
    // The 9 KiB message is omitted while its canonical awareness remains visible and
    // truthful as truncated. Its transcript cursor stays put while the awareness
    // components may advance; the complete small source advances in full.
    expect(prepared?.updates.map((update) => update.edge.sourceSessionId).sort()).toEqual(['a', 'b']);
    expect(prepared?.updates.find((update) => update.edge.sourceSessionId === 'a')).toMatchObject({
      recentMessages: [],
      truncated: true,
    });
    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: null });
    await Promise.resolve();
    expect(acknowledgeSessionFollow).toHaveBeenCalledTimes(2);
    expect(acknowledgeSessionFollow).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'a',
      consumed: { ...frontier, transcriptSeq: 0 },
    }));
    expect(acknowledgeSessionFollow).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: 'b' }));
  });

  it('ACKs valid non-renderable rows but never crosses a renderable row omitted by the byte budget', async () => {
    const acknowledgeSessionFollow = vi.fn().mockResolvedValue({
      ok: true, v: 1, destinationSessionId: 'destination', sourceSessionId: 'source', delivered: frontier,
    });
    const observedFrontier = { ...frontier, transcriptSeq: 5 };
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true,
        v: 1,
        sessionId: 'destination',
        publisherGeneration: 'semantic-frontier',
        observations: [{
          sourceSessionId: 'source', destinationSessionId: 'destination',
          delivered: zeroFrontier, observed: observedFrontier,
        }],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const prepared = await createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 600,
      hydrateObservation: async ({ observation }) => ({
        ...envelopeFor({ ...observation, observed: observedFrontier } as never),
        observed: observedFrontier,
        recentMessages: [
          { messageId: 'seq:3', seq: 3, text: 'fits', provenance: null },
          { messageId: 'seq:5', seq: 5, text: 'x'.repeat(2_000), provenance: null },
        ],
        // seq 1-2 are valid non-renderable rows, seq 4 is another valid
        // non-renderable row, and seq 5 is the first omitted renderable row.
        transcriptConsumedThroughByRenderedMessageCount: [2, 4, 5],
      }) as never,
    })({ signal: new AbortController().signal });

    expect(prepared?.updates).toEqual([
      expect.objectContaining({
        recentMessages: [expect.objectContaining({ seq: 3, text: 'fits' })],
        observed: expect.objectContaining({ transcriptSeq: 4 }),
        truncated: true,
      }),
    ]);
    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'input-semantic', userMessageSeq: 9 });
    await Promise.resolve();
    expect(acknowledgeSessionFollow).toHaveBeenCalledWith(expect.objectContaining({
      consumed: expect.objectContaining({ transcriptSeq: 4 }),
    }));
  });

  it('does not acknowledge after abort, allowing reconnect without duplicate accepted context', async () => {
    const acknowledgeSessionFollow = vi.fn();
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '6',
        observations: [{
          sourceSessionId: 'source', destinationSessionId: 'destination', delivered: zeroFrontier, observed: frontier,
        }],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const controller = new AbortController();
    const prepared = await createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: async ({ observation }) => envelopeFor(observation as never) as never,
    })({ signal: controller.signal });
    expect(prepared?.updates).toHaveLength(1);
    controller.abort();
    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: null });
    await Promise.resolve();
    expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
  });

  it('re-admits the exact edge after hydration and omits context when access was revoked meanwhile', async () => {
    const observation = {
      sourceSessionId: 'source', destinationSessionId: 'destination',
      delivered: zeroFrontier, observed: frontier,
    };
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn()
        .mockResolvedValueOnce({ ok: true, v: 1, sessionId: 'destination', publisherGeneration: '8', observations: [observation] })
        .mockResolvedValueOnce({ ok: true, v: 1, sessionId: 'destination', publisherGeneration: '8', observations: [] }),
      acknowledgeSessionFollow: vi.fn(),
    } as unknown as ApiSessionClient;

    const prepared = await createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: async ({ observation: current }) => envelopeFor(current as never) as never,
    })({ signal: new AbortController().signal });

    expect(session.observePendingSessionFollow).toHaveBeenCalledTimes(2);
    expect(prepared).toBeNull();
  });

  it('does not skip an older oversized message to acknowledge a newer suffix', async () => {
    const acknowledgeSessionFollow = vi.fn().mockResolvedValue({
      ok: true,
      v: 1,
      destinationSessionId: 'destination',
      sourceSessionId: 'source',
      delivered: { ...frontier, transcriptSeq: 0 },
    });
    const observation = {
      sourceSessionId: 'source', destinationSessionId: 'destination',
      delivered: zeroFrontier, observed: frontier,
    };
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '9', observations: [observation],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const prepared = await createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 300,
      hydrateObservation: async ({ observation: current }) => ({
        ...envelopeFor(current as never),
        recentMessages: [
          { messageId: 'seq:1', seq: 1, text: 'old'.repeat(100), provenance: null },
          { messageId: 'seq:2', seq: 2, text: 'new', provenance: null },
        ],
      }) as never,
    })({ signal: new AbortController().signal });

    expect(prepared?.updates[0]?.truncated).toBe(true);
    expect(prepared?.updates[0]?.recentMessages).toEqual([]);
    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: 1 });
    await Promise.resolve();
    expect(acknowledgeSessionFollow).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'source',
      expected: zeroFrontier,
      observed: frontier,
      consumed: { ...frontier, transcriptSeq: 0 },
    }));
  });

  it('accepts a bounded hydrated transcript prefix while preserving the exact observed awareness', async () => {
    const acknowledgeSessionFollow = vi.fn();
    const observed = { transcriptSeq: 30, readyEventSeq: 1, agentStateVersion: 3, turn: frontier.turn };
    const sourceObservation = {
      sourceSessionId: 'source',
      destinationSessionId: 'destination',
      delivered: zeroFrontier,
      observed,
    };
    const session = {
      sessionId: 'destination',
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true,
        v: 1,
        sessionId: 'destination',
        publisherGeneration: '10',
        observations: [sourceObservation],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const prepared = await createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation: async ({ observation }) => ({
        ...envelopeFor(observation as never),
        observed: { ...observed, transcriptSeq: 20 },
        recentMessages: Array.from({ length: 19 }, (_, index) => ({
          messageId: `seq:${index + 2}`,
          seq: index + 2,
          text: `message-${index + 2}`,
          provenance: null,
        })),
        truncated: true,
      }) as never,
    })({ signal: new AbortController().signal });

    expect(prepared?.updates[0]?.observed).toEqual({ ...observed, transcriptSeq: 20 });
  });

  it('acknowledges only the valid contiguous transcript prefix before a corrupt row', async () => {
    const delivered: SessionFollowFrontierV1 = {
      transcriptSeq: 1,
      readyEventSeq: 0,
      agentStateVersion: 0,
      turn: null,
    };
    const observed: SessionFollowFrontierV1 = {
      transcriptSeq: 4,
      readyEventSeq: 1,
      agentStateVersion: 3,
      turn: frontier.turn,
    };
    const acknowledgeSessionFollow = vi.fn().mockResolvedValue({
      ok: true,
      v: 1,
      destinationSessionId: 'destination',
      sourceSessionId: 'source',
      delivered: { ...observed, transcriptSeq: 2 },
    });
    const session = {
      sessionId: 'destination',
      runSessionFollowSourceRequest: <T>(input: Readonly<{ request: () => T }>): T => input.request(),
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true,
        v: 1,
        sessionId: 'destination',
        publisherGeneration: '10',
        observations: [{ sourceSessionId: 'source', destinationSessionId: 'destination', delivered, observed }],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const hydrateObservation = createSessionFollowSourceHydrator({
      session,
      credentials: { token: 'token' } as never,
      deps: {
        resolveSourceTransport: (async () => ({
          ok: true,
          sessionId: 'source',
          rawSession: { id: 'source', encryptionMode: 'plain' },
          accountEncryptionCurrentness: { mode: 'plain' },
          ctx: null,
          mode: 'plain',
        })) as never,
        fetchTranscriptPage: (async () => ({
          messages: [
            { seq: 2, createdAt: 2, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'accepted prefix' } } } },
            { seq: 3, createdAt: 3, content: { t: 'plain', v: { role: 'invalid', content: { type: 'text', text: 'corrupt' } } } },
            { seq: 4, createdAt: 4, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'must remain pending' } } } },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        })) as never,
        projectSourceAwareness: () => envelopeFor({
          sourceSessionId: 'source',
          destinationSessionId: 'destination',
          observed: frontier,
        }).awareness as never,
      },
    });

    const prepared = await createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation,
    })({ signal: new AbortController().signal });

    expect(prepared?.updates[0]).toMatchObject({
      observed: { transcriptSeq: 2 },
      recentMessages: [{ seq: 2, text: 'accepted prefix' }],
      truncated: true,
    });
    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: 7 });
    await Promise.resolve();
    expect(acknowledgeSessionFollow).toHaveBeenCalledWith(expect.objectContaining({
      expected: delivered,
      observed,
      consumed: { ...observed, transcriptSeq: 2 },
    }));
  });

  it('admits more than twenty tiny messages through the final byte budget and acknowledges one contiguous prefix', async () => {
    const current: SessionFollowFrontierV1 = { transcriptSeq: 45, readyEventSeq: 2, agentStateVersion: 4, turn: frontier.turn };
    let delivered: SessionFollowFrontierV1 = { ...zeroFrontier };
    const acknowledgeSessionFollow = vi.fn(async (input: Readonly<{ consumed: typeof current }>) => {
      delivered = { ...input.consumed };
      return {
        ok: true as const,
        v: 1 as const,
        destinationSessionId: 'destination',
        sourceSessionId: 'source',
        delivered,
      };
    });
    const session = {
      sessionId: 'destination',
      runSessionFollowSourceRequest: <T>(input: Readonly<{ request: () => T }>): T => input.request(),
      observePendingSessionFollow: vi.fn(async () => ({
        ok: true as const,
        v: 1 as const,
        sessionId: 'destination',
        publisherGeneration: '11',
        observations: delivered.transcriptSeq === current.transcriptSeq
          ? []
          : [{
              sourceSessionId: 'source',
              destinationSessionId: 'destination',
              delivered: { ...delivered },
              observed: current,
            }],
      })),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    const fetchTranscriptPage = vi.fn(async (input: Readonly<{ afterSeq?: number; limit: number }>) => {
      const afterSeq = input.afterSeq ?? 0;
      const lastSeq = Math.min(current.transcriptSeq, afterSeq + input.limit);
      return {
        messages: Array.from({ length: Math.max(0, lastSeq - afterSeq) }, (_, index) => {
          const seq = afterSeq + index + 1;
          return {
            seq,
            createdAt: seq,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `message-${seq}` } } },
          };
        }),
        hasMore: lastSeq < current.transcriptSeq,
        nextBeforeSeq: null,
        nextAfterSeq: lastSeq < current.transcriptSeq ? lastSeq : null,
      };
    });
    const hydrateObservation = createSessionFollowSourceHydrator({
      session,
      credentials: { token: 'token' } as never,
      deps: {
        resolveSourceTransport: (async () => ({
          ok: true,
          sessionId: 'source',
          rawSession: { id: 'source', encryptionMode: 'plain' },
          accountEncryptionCurrentness: { mode: 'plain' },
          ctx: null,
          mode: 'plain',
        })) as never,
        fetchTranscriptPage: fetchTranscriptPage as never,
        projectSourceAwareness: () => envelopeFor({
          sourceSessionId: 'source',
          destinationSessionId: 'destination',
          observed: frontier,
        }).awareness as never,
      },
    });
    const reconcile = createSessionFollowContextReconciler({
      session,
      maxFollowContextUtf8Bytes: 100_000,
      hydrateObservation,
    });

    const prepared = await reconcile({ signal: new AbortController().signal });
    expect(prepared).not.toBeNull();
    expect(prepared?.updates[0]?.recentMessages).toHaveLength(45);
    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'input-1', userMessageSeq: null });
    await Promise.resolve();

    expect(fetchTranscriptPage.mock.calls.map(([input]) => input.afterSeq)).toEqual([0]);
    expect(fetchTranscriptPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 }));
    expect(acknowledgeSessionFollow.mock.calls.map(([input]) => input.consumed)).toEqual([current]);
    expect(delivered).toEqual(current);
  });

  it('delivers one bounded current Account Voice snapshot and ACKs its exact original frontier', async () => {
    const observed: SessionFollowFrontierV1 = {
      transcriptSeq: 600,
      readyEventSeq: 7,
      agentStateVersion: 11,
      turn: { id: 'turn-600', status: 'completed' },
    };
    let delivered: SessionFollowFrontierV1 | null = null;
    const acknowledgeAccountVoiceFollow = vi.fn(async (input: Readonly<{
      consumed: SessionFollowFrontierV1;
    }>) => {
      delivered = input.consumed;
      return {
        ok: true as const,
        v: 1 as const,
        voiceSessionId: 'destination',
        sourceSessionId: 'source',
        delivered,
      };
    });
    const observePendingAccountVoiceFollow = vi.fn(async () => ({
      ok: true as const,
      v: 1 as const,
      voiceSessionId: 'destination',
      publisherGeneration: '12',
      executionRunOccurrenceId: 'voice-occurrence-1',
      observations: delivered === null ? [{
        sourceSessionId: 'source',
        voiceSessionId: 'destination',
        expected: null,
        observed,
      }] : [],
    }));
    const session = {
      sessionId: 'destination',
      runSessionFollowSourceRequest: <T>(input: Readonly<{ request: () => T }>): T => input.request(),
      observePendingAccountVoiceFollow,
      acknowledgeAccountVoiceFollow,
    } as unknown as ApiSessionClient;
    const fetchTranscriptPage = vi.fn(async (input: Readonly<{
      afterSeq?: number;
      beforeSeq?: number;
      limit: number;
    }>) => {
      const upperInclusive = input.beforeSeq === undefined
        ? Math.min(observed.transcriptSeq, (input.afterSeq ?? 0) + input.limit)
        : Math.min(observed.transcriptSeq, input.beforeSeq - 1);
      const lowerInclusive = input.beforeSeq === undefined
        ? (input.afterSeq ?? 0) + 1
        : Math.max(1, upperInclusive - input.limit + 1);
      const seqs = Array.from(
        { length: Math.max(0, upperInclusive - lowerInclusive + 1) },
        (_, index) => lowerInclusive + index,
      );
      if (input.beforeSeq !== undefined) seqs.reverse();
      return {
        messages: seqs.map((seq) => ({
          seq,
          createdAt: seq,
          content: {
            t: 'plain' as const,
            v: {
              role: 'user' as const,
              content: { type: 'text' as const, text: `current-context-${seq}-${'x'.repeat(40)}` },
            },
          },
        })),
        hasMore: lowerInclusive > 1,
        nextBeforeSeq: lowerInclusive > 1 ? lowerInclusive : null,
        nextAfterSeq: upperInclusive < observed.transcriptSeq ? upperInclusive : null,
      };
    });
    const hydrateObservation = createSessionFollowSourceHydrator({
      session,
      credentials: { token: 'token' } as never,
      deps: {
        resolveSourceTransport: (async () => ({
          ok: true,
          sessionId: 'source',
          rawSession: { id: 'source', encryptionMode: 'plain' },
          accountEncryptionCurrentness: { mode: 'plain' },
          ctx: null,
          mode: 'plain',
        })) as never,
        fetchTranscriptPage: fetchTranscriptPage as never,
        projectSourceAwareness: () => envelopeFor({
          sourceSessionId: 'source',
          destinationSessionId: 'destination',
          observed: frontier,
        }).awareness as never,
      },
    });
    const prepared = await createSessionFollowContextReconciler({
      session,
      observer: { kind: 'account_voice', accountId: 'account', voiceSessionId: 'destination' },
      maxFollowContextUtf8Bytes: 900,
      hydrateObservation,
    })({ signal: new AbortController().signal, executionRunId: 'voice-run-1' });

    expect(prepared?.updates).toHaveLength(1);
    const deliveredSeqs = prepared?.updates[0]?.recentMessages.map((message) => message.seq) ?? [];
    expect(deliveredSeqs.length).toBeGreaterThan(0);
    expect(deliveredSeqs[0]).toBeGreaterThan(500);
    expect(deliveredSeqs.at(-1)).toBe(600);
    expect(prepared?.updates[0]).toMatchObject({
      observed,
      truncated: true,
    });
    expect(fetchTranscriptPage).toHaveBeenCalledWith(expect.objectContaining({
      beforeSeq: 601,
      limit: 500,
    }));
    expect(fetchTranscriptPage).toHaveBeenCalledWith(expect.not.objectContaining({ afterSeq: expect.anything() }));
    expect(observePendingAccountVoiceFollow).toHaveBeenCalledWith({ executionRunId: 'voice-run-1' });
    expect(acknowledgeAccountVoiceFollow).not.toHaveBeenCalled();
    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'voice-input', userMessageSeq: null });
    await vi.waitFor(() => expect(acknowledgeAccountVoiceFollow).toHaveBeenCalledOnce());
    expect(acknowledgeAccountVoiceFollow).toHaveBeenCalledWith({
      executionRunId: 'voice-run-1',
      expectedExecutionRunOccurrenceId: 'voice-occurrence-1',
      sourceSessionId: 'source',
      expectedPublisherGeneration: '12',
      expected: null,
      observed,
      consumed: observed,
      acceptance: { localInputId: 'voice-input', userMessageSeq: null },
    });

    const second = await createSessionFollowContextReconciler({
      session,
      observer: { kind: 'account_voice', accountId: 'account', voiceSessionId: 'destination' },
      maxFollowContextUtf8Bytes: 900,
      hydrateObservation,
    })({ signal: new AbortController().signal, executionRunId: 'voice-run-1' });
    expect(second).toBeNull();
    expect(observePendingAccountVoiceFollow).toHaveBeenCalledTimes(3);
  });

  it('caps an initial Account Voice snapshot at its original observation and leaves a concurrent advance pending', async () => {
    const initialObserved: SessionFollowFrontierV1 = {
      transcriptSeq: 600,
      readyEventSeq: 7,
      agentStateVersion: 11,
      turn: { id: 'turn-600', status: 'completed' },
    };
    const advancedObserved: SessionFollowFrontierV1 = {
      transcriptSeq: 650,
      readyEventSeq: 7,
      agentStateVersion: 11,
      turn: { id: 'turn-600', status: 'completed' },
    };
    let delivered: SessionFollowFrontierV1 | null = null;
    let observeCount = 0;
    const acknowledgeAccountVoiceFollow = vi.fn(async (input: Readonly<{ consumed: SessionFollowFrontierV1 }>) => {
      delivered = input.consumed;
      return {
        ok: true as const,
        v: 1 as const,
        voiceSessionId: 'destination',
        sourceSessionId: 'source',
        delivered,
      };
    });
    const observePendingAccountVoiceFollow = vi.fn(async () => {
      observeCount += 1;
      const current = observeCount === 1 ? initialObserved : advancedObserved;
      return {
        ok: true as const,
        v: 1 as const,
        voiceSessionId: 'destination',
        publisherGeneration: '12',
        executionRunOccurrenceId: 'voice-occurrence-1',
        observations: delivered && delivered.transcriptSeq === current.transcriptSeq ? [] : [{
          sourceSessionId: 'source',
          voiceSessionId: 'destination',
          expected: delivered,
          observed: current,
        }],
      };
    });
    const hydrateObservation = vi.fn<SessionFollowHydrateObservation>(async ({ observation, readMode }) => ({
      ...SessionFollowUpdateEnvelopeV1Schema.parse({
        ...envelopeFor({
          sourceSessionId: observation.sourceSessionId,
          destinationSessionId: observation.destinationSessionId,
          observed: observation.observed as typeof frontier,
        }),
        observed: observation.observed,
        recentMessages: readMode === 'initial_current_snapshot'
          ? [{ messageId: 'seq:600', seq: 600, text: 'snapshot tail', provenance: null }]
          : [{ messageId: 'seq:650', seq: 650, text: 'later change', provenance: null }],
      }),
      sourceRecencyMs: 1,
    }));
    const session = {
      sessionId: 'destination',
      observePendingAccountVoiceFollow,
      acknowledgeAccountVoiceFollow,
    } as unknown as ApiSessionClient;
    const reconcile = createSessionFollowContextReconciler({
      session,
      observer: { kind: 'account_voice', accountId: 'account', voiceSessionId: 'destination' },
      maxFollowContextUtf8Bytes: 8_192,
      hydrateObservation,
    });

    const prepared = await reconcile({
      signal: new AbortController().signal,
      executionRunId: 'voice-run-1',
    });
    expect(hydrateObservation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      observation: expect.objectContaining({ observed: initialObserved }),
      readMode: 'initial_current_snapshot',
    }));
    prepared?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'voice-input', userMessageSeq: null });
    await vi.waitFor(() => expect(acknowledgeAccountVoiceFollow).toHaveBeenCalledOnce());
    expect(acknowledgeAccountVoiceFollow).toHaveBeenCalledWith(expect.objectContaining({
      expected: null,
      observed: initialObserved,
      consumed: initialObserved,
    }));

    const later = await reconcile({
      signal: new AbortController().signal,
      executionRunId: 'voice-run-1',
    });
    expect(later?.updates[0]).toMatchObject({
      observed: advancedObserved,
      recentMessages: [{ seq: 650, text: 'later change' }],
    });
    expect(hydrateObservation).toHaveBeenNthCalledWith(2, expect.objectContaining({
      observation: expect.objectContaining({
        delivered: initialObserved,
        observed: advancedObserved,
      }),
      readMode: 'incremental',
    }));
  });
});

describe('Session Follow wake discovery beyond one transcript page', () => {
  const PAGE = 500;
  const humanSeq = PAGE + 1;
  const wakeDelivered: SessionFollowFrontierV1 = { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null };
  const wakeObserved: SessionFollowFrontierV1 = { transcriptSeq: humanSeq, readyEventSeq: 0, agentStateVersion: 0, turn: null };
  const wakeAwareness = envelopeFor({ sourceSessionId: 'source', destinationSessionId: 'destination', observed: frontier }).awareness;

  function storedRow(seq: number, withHuman: boolean) {
    const isHuman = withHuman && seq === humanSeq;
    return {
      seq,
      createdAt: seq,
      content: { t: 'plain' as const, v: {
        role: 'user',
        content: { type: 'text', text: isHuman ? 'human asks for a check' : `automation note ${seq}` },
        ...(isHuman ? { meta: { happierProvenanceV1: { v: 1, kind: 'cli' } } } : {}),
      } },
    };
  }

  function rowsAfter(afterSeq: number, withHuman: boolean) {
    const rows = [];
    for (let seq = afterSeq + 1; seq <= Math.min(afterSeq + PAGE, humanSeq); seq += 1) rows.push(storedRow(seq, withHuman));
    return { rows, hasMore: afterSeq + PAGE < humanSeq };
  }

  function createDestination() {
    const acknowledgeSessionFollow = vi.fn().mockResolvedValue({ ok: true });
    const session = {
      sessionId: 'destination',
      runSessionFollowSourceRequest: <T>(input: Readonly<{ request: () => T }>): T => input.request(),
      observePendingSessionFollow: vi.fn().mockResolvedValue({
        ok: true,
        v: 1,
        sessionId: 'destination',
        publisherGeneration: '11',
        observations: [{
          sourceSessionId: 'source',
          destinationSessionId: 'destination',
          delivered: wakeDelivered,
          observed: wakeObserved,
          mode: 'wake_on_human_change',
        }],
      }),
      acknowledgeSessionFollow,
    } as unknown as ApiSessionClient;
    return { session, acknowledgeSessionFollow };
  }

  function accountTransportHydrator(session: ApiSessionClient, withHuman: boolean) {
    const fetchTranscriptPage = vi.fn(async (input: { afterSeq?: number }) => {
      const page = rowsAfter(input.afterSeq ?? 0, withHuman);
      return { messages: page.rows, hasMore: page.hasMore, nextBeforeSeq: null, nextAfterSeq: null };
    });
    const hydrate = createSessionFollowSourceHydrator({
      session,
      credentials: { token: 'token' } as never,
      deps: {
        resolveSourceTransport: (async () => ({
          ok: true,
          sessionId: 'source',
          rawSession: { id: 'source', encryptionMode: 'plain' },
          accountEncryptionCurrentness: { mode: 'plain' },
          ctx: null,
          mode: 'plain',
        })) as never,
        fetchTranscriptPage: fetchTranscriptPage as never,
        projectSourceAwareness: () => wakeAwareness as never,
      },
    });
    return { hydrate, fetchTranscriptPage };
  }

  function runnerTransportHydrator(session: ApiSessionClient, withHuman: boolean) {
    const fetchRunnerSourceProjection = vi.fn(async (input: { afterTranscriptSeq: number }) => {
      const page = rowsAfter(input.afterTranscriptSeq, withHuman);
      return {
        v: 1 as const,
        source: {
          id: 'source', encryptionMode: 'plain' as const, metadata: null, metadataLayoutVersion: 0,
          archivedAt: null, createdAt: 1, updatedAt: 2, active: true, activeAt: 2,
          thinking: false, thinkingAt: null, latestTurnStatus: null, latestTurnStatusObservedAt: null,
          latestReadyEventSeq: null, latestReadyEventAt: null, meaningfulActivityAt: null, agentStateVersion: 0,
        },
        messages: page.rows.map((row) => ({ ...row, accountActor: null })),
        hasMore: page.hasMore,
      };
    });
    const hydrate = createSessionFollowSourceHydrator({
      session,
      credentials: { token: 'runner-token', encryption: null } as never,
      sourceMaterialResolver: {
        installPreparedDataKey: () => 'installed',
        resolveForHydration: () => ({ mode: 'plain' }),
      },
      deps: {
        fetchRunnerSourceProjection: fetchRunnerSourceProjection as never,
        projectSourceAwareness: () => wakeAwareness as never,
      },
    });
    return { hydrate, fetchRunnerSourceProjection };
  }

  it.each(['account', 'runner'] as const)(
    'wakes for protected human ingress beyond a full nonhuman first page on the %s transport and ACKs only the delivered contiguous prefix',
    async (transport) => {
      const { session, acknowledgeSessionFollow } = createDestination();
      const built = transport === 'account'
        ? accountTransportHydrator(session, true)
        : runnerTransportHydrator(session, true);
      const prepared = await createSessionFollowContextReconciler({
        session,
        maxFollowContextUtf8Bytes: 1_000_000,
        hydrateObservation: built.hydrate,
      })({ signal: new AbortController().signal, deliveryIntent: 'wake' });

      expect(prepared?.wakeEventLocalId).toMatch(/^session-follow-wake:/u);
      const update = prepared!.updates[0]!;
      expect(update).toMatchObject({ reason: 'human_changed_source', deliveryIntent: 'wake', truncated: true });
      // Delivery stays the oldest contiguous page; the discovered human row is not skipped to.
      expect(update.recentMessages.some((message) => message.seq > PAGE)).toBe(false);
      expect(update.observed.transcriptSeq).toBeLessThanOrEqual(PAGE);
      const fetch = transport === 'account'
        ? (built as ReturnType<typeof accountTransportHydrator>).fetchTranscriptPage
        : (built as ReturnType<typeof runnerTransportHydrator>).fetchRunnerSourceProjection;
      expect(fetch).toHaveBeenCalledTimes(2);

      prepared!.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: prepared!.wakeEventLocalId! });
      await Promise.resolve();
      expect(acknowledgeSessionFollow).toHaveBeenCalledOnce();
      const ack = acknowledgeSessionFollow.mock.calls[0]![0] as { consumed: SessionFollowFrontierV1; observed: SessionFollowFrontierV1 };
      expect(ack.observed).toEqual(wakeObserved);
      expect(ack.consumed.transcriptSeq).toBeLessThanOrEqual(PAGE);
    },
  );

  it.each(['account', 'runner'] as const)(
    'does not wake on the %s transport when no protected human ingress exists anywhere in the pending range',
    async (transport) => {
      const { session, acknowledgeSessionFollow } = createDestination();
      const built = transport === 'account'
        ? accountTransportHydrator(session, false)
        : runnerTransportHydrator(session, false);
      const prepared = await createSessionFollowContextReconciler({
        session,
        maxFollowContextUtf8Bytes: 1_000_000,
        hydrateObservation: built.hydrate,
      })({ signal: new AbortController().signal, deliveryIntent: 'wake' });

      expect(prepared).toBeNull();
      expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
    },
  );
});
