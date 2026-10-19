import type { DiscussionId } from '../sessions/idsV1.js';

/**
 * Canonical committed sequence reference for one Session Activity event.
 *
 * The sequence owner is part of the identity because the main transcript and
 * every Discussion allocate independent sequence numbers.
 */
export type ActivitySequenceEventReferenceV1 =
  | Readonly<{
      sequenceDomain: 'session_transcript';
      sequence: number;
    }>
  | Readonly<{
      sequenceDomain: 'discussion';
      discussionId: DiscussionId;
      sequence: number;
    }>;

/** Stable device-local identity shared by every leg observing the event. */
export function resolveActivitySequenceEventIdentityV1(
  reference: ActivitySequenceEventReferenceV1,
): string {
  return reference.sequenceDomain === 'discussion'
    ? `message-seq:discussion:${reference.discussionId}:${reference.sequence}`
    : `message-seq:session_transcript:${reference.sequence}`;
}

/**
 * Reader-compatible identity for the released V1 remote-alert shape.
 *
 * V1 did not identify the sequence owner, so it must remain distinct from the
 * canonical current identity rather than suppressing a potentially different
 * transcript or Discussion event.
 */
export function resolveLegacyActivitySequenceEventIdentityV1(sequence: number): string {
  return `legacy-message-seq:${sequence}`;
}

/** Stable identity for committed turn-scoped Activity events. */
export function resolveActivityTurnEventIdentityV1(turnId: string): string {
  return `turn:${turnId}`;
}

/** The presence owner already commits this exact fence; no extra event id is allocated. */
export function resolveActivityStalledEventIdentityV1(occurrence: Readonly<{ turnId: string; publisherFence: number }>): string {
  return `stalled:${occurrence.turnId}:${occurrence.publisherFence}`;
}

/**
 * Stable identity for a committed Agent request (permission or user action).
 *
 * The request id is allocated by the Agent runtime before commit, so both legs
 * that can observe the same request — this device's own local notification and
 * the Home's remote alert — name it identically and one of them suppresses.
 */
export function resolveActivityRequestEventIdentityV1(requestId: string): string {
  return `request:${requestId}`;
}

/** The existing transcript transport correlation, available before its server ACK. */
export function resolveActivityTranscriptLocalIdEventIdentityV1(localId: string): string {
  return `message-local-id:session_transcript:${localId}`;
}
