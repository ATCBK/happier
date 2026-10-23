import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol';
import { db } from '../../../../../../server/sources/storage/db';
import { createLightSqliteHarness } from '../../../../../../server/sources/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '../../../../../../server/sources/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionMessage } from '../../../../../../server/sources/app/session/sessionWriteService';

import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { createExternalSessionTerminalFollowProjector } from '@/session/external/terminalFollowProjection';

import { createRuntimeTranscriptProjector, projectRuntimeTranscriptEvent, type RuntimeTranscriptProjectionSession } from './projectRuntimeTranscriptEvent';

describe('runtime transcript custody', () => {
  it.each(['runtime', 'source-follow', 'source-first'] as const)('joins a Session-scoped native final to its named foreground stream without a second timestamp owner (%s)', async (route) => {
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-transcript-final-ack-',
      env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    let bridge: ReturnType<typeof createKeyedStreamedTranscriptBridge> | undefined;
    try {
      const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
      const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
      const committedFence = new Date(1000);
      const storedSession = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), active: true,
        lastActiveAt: committedFence, encryptionMode: 'plain', metadataLayoutVersion: 1,
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: {} })),
        ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 })),
      } });
      await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: storedSession.id, data: 'fixture' } });
      const authentication = createPresentUserSessionAccessAuthentication();
      // Substitute the transport only: the canonical Home writer, source timestamp
      // admission, database and host stream/projector all run as production code.
      const session: RuntimeTranscriptProjectionSession = { sessionId: storedSession.id,
        async enqueueAgentMessageCommitted(provider, body, opts) {
          const result = await createSessionMessage({ authentication, inputAdmission: 'transcriptOnly',
            actorUserId: account.id, sessionId: storedSession.id, localId: opts.localId, messageRole: 'agent',
            content: { t: 'plain', v: buildAcpAgentMessageEnvelope({ provider, body, meta: opts.meta }) },
            publisherAuthority: { accountId: account.id, machineId: machine.id, sessionId: storedSession.id, committedFence },
            trustedSourceTimestamps: { createdAt: opts.createdAt ?? Date.now(), updatedAt: opts.updatedAt ?? Date.now() },
            trustedTranscriptObservationProvenance: opts.provenance,
          });
          if (!result.ok) throw new Error(`Home refused transcript observation: ${result.error}`);
          return { persisted: true, delivered: true, committedSequence: result.message.seq };
        },
      };
      bridge = createKeyedStreamedTranscriptBridge({ provider: 'agent', createSessionForStream: () => session,
        durableCommitsRequireExplicitEnable: true });
      const project = createRuntimeTranscriptProjector();
      let sequence = 0;
      const emit = (event: Record<string, unknown>) => project({ session, provider: 'agent', runtimeMessageDeltaBridge: bridge,
        event: AgentSessionRuntimeEventSchema.parse({ sessionId: session.sessionId, emittedAtMs: 1000 + ++sequence, sequence, ...event }) });
      const emitDelta = () => emit({ kind: 'message-delta', turnId: 'foreground', channel: 'assistant', messageId: 'native-final', text: 'Partial' });
      const earlierDelta = route === 'source-first' ? undefined : emitDelta();
      let final: Promise<unknown>;
      if (route === 'runtime') {
        final = emit({ kind: 'transcript-message-committed', role: 'assistant', messageId: 'native-final', text: 'Exact native final' });
      } else {
        const follow = createExternalSessionTerminalFollowProjector({ sessionId: session.sessionId, agentId: 'agent',
          projectRuntimeEvent: (event, admission) => projectRuntimeTranscriptEvent({ session, provider: 'agent', event, admission }) });
        final = follow({ kind: 'data', fromCursor: 'before', nextCursor: 'after', items: [{
          kind: 'agent', id: 'native-final', localId: 'native-final', timestampMs: 1002,
          data: StrictJsonValueSchema.parse(buildAcpAgentMessageEnvelope({ provider: 'agent', body: { type: 'message', message: 'Exact native final' } })),
        }] }, { signal: new AbortController().signal, requireDelivery: true });
      }
      const outcomes = await Promise.allSettled([earlierDelta ?? emitDelta(), final, emit({ kind: 'turn-complete', turnId: 'foreground' })]);
      expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
      const rows = await db.sessionMessage.findMany({ where: { sessionId: storedSession.id } });
      expect(rows).toHaveLength(1);
      expect(outcomes[2]).toMatchObject({ status: 'fulfilled', value: { projected: true } });
      // A late delta consumes its already acknowledged native identity; the
      // lifecycle retains that receipt even when terminal flush has no stream.
      expect(outcomes[route === 'source-first' ? 0 : 2]).toMatchObject({
        status: 'fulfilled', value: { finalAssistantMessageSeq: rows[0]!.seq },
      });
      expect(rows[0]?.content).toMatchObject({ v: { content: { data: { type: 'message', message: 'Exact native final' } } } });
    } finally {
      bridge?.clear();
      await harness.close();
    }
  }, 180_000);

});
