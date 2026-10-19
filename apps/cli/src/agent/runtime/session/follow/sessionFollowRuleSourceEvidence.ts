import type { SessionAwarenessOriginV1, SessionAwarenessProjectionV1 } from '@happier-dev/protocol';
import { readSessionListStartedByV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { readSessionAwarenessPresentationV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { SessionFollowRuleSourceEvidenceV1Schema, type SessionFollowRuleSourceEvidenceV1, type SessionFollowRuleSourceOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import type { FollowEventV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { RawTranscriptRow } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { openSessionStoredContent, type SessionStoredContentEncryptionMode, type SessionEncryptionContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { createTranscriptRawRecordV1Schema, TranscriptRawAgentEventV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { SessionMessageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { SessionFollowSourceMessageV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';
import { SessionIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { z } from 'zod/mini';
import { readVerifiedSessionFollowHumanInputOriginal } from '@/api/session/client/transcript/sessionFollowHumanInputOccurrence';

type WithoutPublisher<Occurrence> = Occurrence extends unknown ? Omit<Occurrence, 'sourcePublisher'> : never;
export type SessionFollowAccountOccurrence = WithoutPublisher<SessionFollowRuleSourceOccurrenceV1>;
export type CommittedSessionFollowSourceOccurrenceRead = Readonly<{ status: 'occurrence'; occurrence: SessionFollowAccountOccurrence }>
  | Readonly<{ status: 'not_semantic' }> | Readonly<{ status: 'unavailable' }>;

// Authored metadata is not semantic evidence. Its protected human fields have
// their own canonical proof owner; the raw-record factory validates the body.
const SourceRawRecordSchema = createTranscriptRawRecordV1Schema(z, { metaSchema: z.unknown() });

/** Opens one already-authorized committed row; callers own paging and current predicate facts. */
export function readCommittedSessionFollowSourceOccurrence(input: Pick<SourceFacts, 'serverId' | 'ownerAccountId' | 'origin'> & Readonly<{
  sourceSessionId: string; row: RawTranscriptRow; mode: SessionStoredContentEncryptionMode; ctx: SessionEncryptionContext | null;
}>): CommittedSessionFollowSourceOccurrenceRead {
  const row = SessionMessageV1Schema.safeParse(input.row);
  const sourceSessionId = SessionIdSchema.safeParse(input.sourceSessionId);
  if (!row.success || !sourceSessionId.success) return { status: 'unavailable' };
  if (row.data.sidechainId) return { status: 'not_semantic' };
  try {
    let opened: unknown;
    if (input.mode === 'plain') opened = openSessionStoredContent({ mode: 'plain', ctx: null, content: row.data.content });
    else {
      if (!input.ctx) return { status: 'unavailable' };
      opened = openSessionStoredContent({ mode: 'e2ee', ctx: input.ctx, content: row.data.content });
    }
    const body = SourceRawRecordSchema.safeParse(opened);
    if (!body.success) return { status: 'unavailable' };
    if (body.data.sidechainId || body.data.role === 'agent' && 'sidechainId' in body.data.content
      && body.data.content.sidechainId) return { status: 'not_semantic' };
    let event: FollowEventV1 | null;
    if (body.data.role === 'user') {
      event = readVerifiedSessionFollowHumanInputOriginal({ sessionId: sourceSessionId.data,
        ownerAccountId: input.ownerAccountId, row: row.data, meta: body.data.meta }) ? { kind: 'person_wrote' } : null;
    } else {
      if (row.data.messageRole === 'user') return { status: 'unavailable' };
      const content = body.data.content;
      event = content.type === 'acp' || content.type === 'codex'
        ? readSessionFollowSemanticSourceEvent(content.data)
        : content.type === 'event' ? readSessionFollowSemanticSourceEvent(content) : null;
    }
    if (!event) return { status: 'not_semantic' };
    const sourceMessage = SessionFollowSourceMessageV1Schema.safeParse({ localId: row.data.localId, seq: row.data.seq });
    if (!sourceMessage.success) return { status: 'unavailable' };
    const evidence = captureSemanticSessionFollowRuleSourceEvidence({ serverId: input.serverId,
      ownerAccountId: input.ownerAccountId, origin: input.origin, event });
    return evidence ? { status: 'occurrence', occurrence: { sourceSessionId: sourceSessionId.data,
      sourceMessage: sourceMessage.data, evidence } } : { status: 'unavailable' };
  } catch { return { status: 'unavailable' }; }
}

/** Original evidence carries only non-private source identity and semantic event facts. */
type SourceFacts = Readonly<{
  serverId: string; ownerAccountId: string; origin: SessionAwarenessOriginV1 | null;
  awareness?: SessionAwarenessProjectionV1;
}>;
export function captureSessionFollowRuleSourceEvidence(input: SourceFacts & Readonly<{ body: ACPMessageData }>): SessionFollowRuleSourceEvidenceV1 | null {
  const event = readSessionFollowSemanticSourceEvent(input.body);
  return event ? captureSemanticSessionFollowRuleSourceEvidence({ ...input, event }) : null;
}

/** One classifier for live typed producers and canonically opened stored records, never metadata hints. */
export function readSessionFollowSemanticSourceEvent(body: Readonly<{
  type: string; sidechainId?: unknown; message?: unknown; data?: unknown;
}>): FollowEventV1 | null {
  // Run-sidechain output has its own lifecycle and cannot assert a parent Session event.
  if (body.sidechainId) return null;
  if (body.type === 'event') {
    const event = createStoredReadSchema(TranscriptRawAgentEventV1Schema).safeParse(body.data);
    return event.success && event.data.type === 'worker-report' ? { kind: 'update_posted' }
      : event.success && event.data.type === 'goal-changed' ? { kind: 'goal_changed' }
        : event.success && event.data.type === 'ready' && typeof event.data.completedTurnId === 'string'
          ? { kind: 'finished' } : null;
  }
  return body.type === 'message' && typeof body.message === 'string' && body.message.trim() ? { kind: 'message' }
    : body.type === 'task_complete' ? { kind: 'finished' }
    : body.type === 'turn_failed' || body.type === 'turn_cancelled' || body.type === 'turn_aborted'
      ? { kind: 'failed_or_stopped' }
    : null;
}

/** Only original semantic owners supply this event; authored message metadata never does. */
export function captureSemanticSessionFollowRuleSourceEvidence(input: SourceFacts & Readonly<{ event: FollowEventV1 }>): SessionFollowRuleSourceEvidenceV1 | null {
  const event = input.event;
  const parsed = SessionFollowRuleSourceEvidenceV1Schema.safeParse({
    v: 1, ownerAccountId: input.ownerAccountId, event,
    facts: { serverId: input.serverId, kind: 'session',
      startedBy: readSessionListStartedByV1({ origin: input.origin ?? undefined,
        ownerAccountId: input.ownerAccountId, viewerAccountId: input.ownerAccountId }),
      source: 'persisted',
      ...(input.awareness ? { status: readSessionAwarenessPresentationV1(input.awareness) } : {}),
      ...(event.kind === 'needs_you' ? { attentionRequired: true } : {}),
    },
  });
  return parsed.success ? parsed.data : null;
}
