import { describe, expect, it } from 'vitest';

import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { createExternalSessionTerminalFollowProjector } from '@/session/external/terminalFollowProjection';

import { projectRuntimeTranscriptEvent, type RuntimeTranscriptProjectionSession } from './projectRuntimeTranscriptEvent';

describe('native transcript finalization and live source follow', () => {
  it.each([true, false])('keeps one durable row while preserving source delivery admission (delivered=%s)', async (delivered) => {
    type Commit = NonNullable<RuntimeTranscriptProjectionSession['enqueueAgentMessageCommitted']>;
    const rows = new Map<string, Parameters<Commit>[1]>();
    let releaseFinal!: () => void;
    const finalCustody = new Promise<void>((resolve) => { releaseFinal = resolve; });
    let reachedFinal!: () => void;
    const finalEntered = new Promise<void>((resolve) => { reachedFinal = resolve; });
    // Durable storage is the boundary: the real stream writer and both runtime
    // projection paths run while its acknowledgement is outstanding.
    const session: RuntimeTranscriptProjectionSession = {
      sessionId: 'native-follow-race',
      async enqueueAgentMessageCommitted(_provider, body, opts) {
        rows.set(opts.localId, body);
        if (opts.meta?.happierStreamSegmentV1 && body.type === 'message' && body.message === 'Native final') {
          reachedFinal();
          await finalCustody;
        }
        return { persisted: true, delivered };
      },
    };
    const bridge = createKeyedStreamedTranscriptBridge({ provider: 'claude', createSessionForStream: () => session });
    let sequence = 0;
    const project = (event: Record<string, unknown>) => projectRuntimeTranscriptEvent({
      session, provider: 'claude', runtimeMessageDeltaBridge: bridge,
      event: AgentSessionRuntimeEventSchema.parse({ sessionId: session.sessionId, emittedAtMs: 1, sequence: ++sequence, ...event }),
    });
    const source = createExternalSessionTerminalFollowProjector({
      sessionId: session.sessionId, agentId: 'claude',
      projectRuntimeEvent: (event, admission) => projectRuntimeTranscriptEvent({ session, provider: 'claude', event, admission }),
    });
    const messageId = 'claude-jsonl:main:assistant:native-final';
    let foreground: Promise<unknown> | undefined;
    let followed: Promise<unknown> | undefined;
    try {
      await project({ kind: 'message-delta', turnId: 'turn', channel: 'assistant', text: 'Draft' });
      foreground = project({ kind: 'transcript-message-committed', turnId: 'turn', role: 'assistant', messageId, text: 'Native final' });
      await finalEntered;
      followed = source({ kind: 'data', fromCursor: 'before', nextCursor: 'after', items: [{
        kind: 'agent', id: messageId, localId: messageId, timestampMs: 2,
        data: StrictJsonValueSchema.parse(buildAcpAgentMessageEnvelope({ provider: 'claude', body: { type: 'message', message: 'Native final' } })),
      }] }, { signal: new AbortController().signal, requireDelivery: true });
      const outcomes = Promise.allSettled([foreground, followed]);
      releaseFinal();
      expect(await outcomes).toEqual([
        expect.objectContaining({ status: 'fulfilled' }),
        delivered
          ? expect.objectContaining({ status: 'fulfilled' })
          : expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ reason: 'delivery_not_confirmed' }) }),
      ]);
      await project({ kind: 'turn-complete', turnId: 'turn' });
      expect([...rows.values()]).toEqual([{ type: 'message', message: 'Native final' }]);
      expect(rows.has(messageId)).toBe(false);

      // Equal text under another native identity is a genuine second message.
      await project({ kind: 'transcript-message-committed', messageId: 'different-native', role: 'assistant', text: 'Native final' });
      expect([...rows.values()]).toEqual([
        { type: 'message', message: 'Native final' }, { type: 'message', message: 'Native final' },
      ]);
    } finally {
      releaseFinal();
      await Promise.allSettled([foreground, followed]);
      bridge.clear();
    }
  });

  it('does not reserve a native identity after refused custody and permits a later retry', async () => {
    let release!: () => void;
    const custody = new Promise<void>((resolve) => { release = resolve; });
    let accepted = false;
    const rows: string[] = [];
    const session: RuntimeTranscriptProjectionSession = {
      sessionId: 'refused-native-custody',
      async enqueueAgentMessageCommitted(_provider, _body, opts) {
        await custody;
        if (accepted) rows.push(opts.localId);
        return { persisted: accepted, delivered: accepted };
      },
    };
    const event = AgentSessionRuntimeEventSchema.parse({ kind: 'transcript-message-committed',
      sessionId: session.sessionId, sequence: 1, emittedAtMs: 1,
      messageId: 'native-refused', role: 'assistant', text: 'Retained output',
    });
    const project = () => projectRuntimeTranscriptEvent({ session, provider: 'claude', event });
    const results = Promise.allSettled([project(), project()]);
    release();
    expect(await results).toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ reason: 'durable_custody_rejected' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ reason: 'durable_custody_rejected' }) }),
    ]);
    expect(rows).toEqual([]);
    accepted = true;
    await project();
    expect(rows).toEqual(['native-refused']);
  });

  it('rechecks the joining source admission after the shared publication settles', async () => {
    let release!: () => void;
    const custody = new Promise<void>((resolve) => { release = resolve; });
    const session: RuntimeTranscriptProjectionSession = {
      sessionId: 'cancelled-source-admission',
      async enqueueAgentMessageCommitted() {
        await custody;
        return { persisted: true, delivered: true };
      },
    };
    const event = AgentSessionRuntimeEventSchema.parse({ kind: 'transcript-message-committed',
      sessionId: session.sessionId, sequence: 1, emittedAtMs: 1,
      messageId: 'native-cancelled-source', role: 'assistant', text: 'Retained output',
    });
    const foreground = projectRuntimeTranscriptEvent({ session, provider: 'claude', event });
    const controller = new AbortController();
    const joining = projectRuntimeTranscriptEvent({ session, provider: 'claude', event,
      admission: { signal: controller.signal, requireDelivery: true } });
    const result = Promise.allSettled([foreground, joining]);
    controller.abort();
    release();
    expect(await result).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ reason: 'admission_expired' }) }),
    ]);
  });
});
