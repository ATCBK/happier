import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

const Timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const CeilingBytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const WarningRule = z.enum(['idle_sessions', 'memory_guard']);
const StopRule = z.enum(['idle_sessions', 'memory_guard', 'ceiling']);
const stopping = { kind: z.literal('stopping'), stopAt: Timestamp, rule: WarningRule };
const stopped = { kind: z.literal('stopped'), at: Timestamp, rule: StopRule,
  idleMs: Timestamp.optional(), freedBytes: Timestamp.optional() };

/** Content-free presentation, carried by the Session's canonical shared metadata. */
export const SessionGuardStateV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ v: z.literal(1), ...stopping, ceilingBytes: CeilingBytes.nullable().optional() }).strict(),
  z.object({ v: z.literal(1), ...stopped, ceilingBytes: CeilingBytes.nullable().optional() }).strict(),
  z.object({ v: z.literal(1), ...stopped, kind: z.literal('requested'), ceilingBytes: CeilingBytes.nullable().optional() }).strict(),
  z.object({ v: z.literal(1), kind: z.literal('configured'), ceilingBytes: CeilingBytes.nullable() }).strict(),
]));
export type SessionGuardStateV1 = z.infer<typeof SessionGuardStateV1Schema>;
export const SessionGuardStateV1StoredSchema = createStoredReadSchema(SessionGuardStateV1Schema);

/** Undefined inherits Machine policy; null is the Session's explicit no-ceiling choice. */
export function readSessionMemoryCeilingOverride(metadata: unknown): number | null | undefined {
  if (!metadata || typeof metadata !== 'object' || !('sessionGuardStateV1' in metadata)) return undefined;
  if (metadata.sessionGuardStateV1 === undefined) return undefined;
  return SessionGuardStateV1StoredSchema.parse(metadata.sessionGuardStateV1).ceilingBytes;
}

/** Shared by the live publisher and the authenticated inactive-Session metadata CAS. */
export function applySessionMemoryCeilingOverrideToMetadata<T extends Record<string, unknown>>(
  metadata: T, bytes: number | null,
): T & { sessionGuardStateV1: SessionGuardStateV1 } {
  const ceilingBytes = CeilingBytes.nullable().parse(bytes);
  const previous = metadata.sessionGuardStateV1;
  const presentation = previous === undefined ? undefined : SessionGuardStateV1StoredSchema.parse(previous);
  const sessionGuardStateV1: SessionGuardStateV1 = presentation
    ? { ...(previous && typeof previous === 'object' ? previous : {}), ...presentation, ceilingBytes }
    : { v: 1, kind: 'configured', ceilingBytes };
  return { ...metadata, sessionGuardStateV1 };
}

export const SessionGuardNoticeStateV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object(stopping).strict(),
  z.object({ ...stopped, ceilingBytes: CeilingBytes.optional() }).strict(),
  z.object({ kind: z.literal('clear') }).strict(),
  z.object({ kind: z.literal('ceiling'), bytes: CeilingBytes.nullable() }).strict(),
  z.object({ kind: z.literal('notify_ceiling'), notice: z.enum(['ceiling_near', 'ceiling_reached']) }).strict(),
  z.object({ kind: z.literal('notify_terminal_warning'), terminalId: z.string().min(1),
    terminalKey: z.string().min(1).max(2000), stopAt: Timestamp, idleMs: Timestamp.optional() }).strict(),
]));
export type SessionGuardNoticeStateV1 = z.infer<typeof SessionGuardNoticeStateV1Schema>;

export const SessionGuardNoticeRequestV1Schema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1), state: SessionGuardNoticeStateV1Schema,
}).strict());
export type SessionGuardNoticeRequestV1 = z.infer<typeof SessionGuardNoticeRequestV1Schema>;
export const SessionGuardNoticeResponseV1Schema = lazyZodSchema(() => z.object({ ok: z.boolean() }).strict());

export const SessionStopRecordV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), at: Timestamp, rule: StopRule, idleMs: Timestamp.optional(), freedBytes: Timestamp.optional(),
  ceilingBytes: CeilingBytes.optional(),
  status: z.enum(['requested', 'stopped', 'cancelled', 'failed']),
  settledAt: Timestamp.optional(),
}).strict());
export type SessionStopRecordV1 = z.infer<typeof SessionStopRecordV1Schema>;
export const SessionStopRecordV1StoredSchema = createStoredReadSchema(SessionStopRecordV1Schema);

/** Immutable transcript intent never claims exit; the current system record owns settlement. */
export function buildSessionStopTranscriptEventV1(record: SessionStopRecordV1): Readonly<{
  type: 'message'; message: string; sessionStopV1: SessionStopRecordV1;
}> {
  const sessionStopV1 = SessionStopRecordV1Schema.parse(record);
  if (sessionStopV1.status !== 'requested') throw new Error('Session stop transcript events require requested intent');
  return { type: 'message', message: 'Happier requested this session to stop. Resume it after it stops to continue.', sessionStopV1 };
}

export function readSessionStopTranscriptRecordV1(event: unknown): SessionStopRecordV1 | null {
  if (!event || typeof event !== 'object' || !('type' in event) || event.type !== 'message'
    || !('sessionStopV1' in event)) return null;
  const parsed = SessionStopRecordV1StoredSchema.safeParse(event.sessionStopV1);
  return parsed.success && parsed.data.status === 'requested' ? parsed.data : null;
}
