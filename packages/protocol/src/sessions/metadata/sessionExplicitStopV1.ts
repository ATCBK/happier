import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import type { ActionExecutorContext } from '../../actions/executor/types.js';

/** Classifies an admitted Stop author; Action dispatch and Home own target scope. */
export function resolveSessionExplicitControlIntent(input: Readonly<{
  rawSession: Readonly<{ id: string }>;
  executionAuthority?: ActionExecutorContext['authority'];
  actionContext?: ActionExecutorContext;
}>): 'person' | 'manager' | 'automatic' | 'unauthorized' | 'self_stop_forbidden' {
  const caller = input.actionContext?.actionCaller;
  const admittedCaller = input.actionContext?.agentStartContext?.caller;
  if (caller?.kind === 'session') {
    if (admittedCaller?.kind !== 'session' || admittedCaller.sessionId !== caller.sessionId) return 'unauthorized';
    return input.rawSession.id === caller.sessionId ? 'self_stop_forbidden' : 'manager';
  }
  return (input.actionContext?.authority ?? input.executionAuthority) === 'account_automation'
    ? 'automatic' : 'person';
}

export const SESSION_EXPLICIT_STOP_METADATA_KEY = 'sessionExplicitStopV1' as const;

export const SessionExplicitStopV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  cause: z.literal('explicit_stop'),
  requestId: z.string().check(z.trim(), z.minLength(1)),
  requestedAtMs: z.number().check(z.int(), z.nonnegative()),
  /** Present only when an admitted managing Session authored Stop. Legacy holds are person-only. */
  managerSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export type SessionExplicitStopV1 = z.infer<typeof SessionExplicitStopV1Schema>;

export type SessionAutoResumeAdmissionV1 =
  | 'eligible'
  | 'held_by_person'
  | 'archived'
  | 'machine_unavailable'
  | 'authority_unavailable';

/** Shared by absent-runtime delivery and the machine's automatic launch owner. */
export function resolveSessionAutoResumeAdmissionV1(input: Readonly<{
  metadata: unknown;
  archivedAt?: unknown;
  machineAvailable: boolean;
  authorityAvailable: boolean;
}>): SessionAutoResumeAdmissionV1 {
  if (input.archivedAt !== null && input.archivedAt !== undefined) return 'archived';
  if (!input.authorityAvailable) return 'authority_unavailable';
  const stop = readSessionExplicitStopV1FromMetadata(input.metadata);
  if (stop && 'status' in stop) return 'authority_unavailable';
  if (stop) return 'held_by_person';
  if (!input.machineAvailable) return 'machine_unavailable';
  return 'eligible';
}

/** Absent means never explicitly stopped. Malformed state is not absence. */
export function readSessionExplicitStopV1FromMetadata(metadata: unknown):
  | SessionExplicitStopV1 | Readonly<{ status: 'invalid' }> | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return { status: 'invalid' };
  const raw = (metadata as Record<string, unknown>)[SESSION_EXPLICIT_STOP_METADATA_KEY];
  if (raw === undefined) return null;
  const parsed = SessionExplicitStopV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : { status: 'invalid' };
}

export function writeSessionExplicitStopV1ToMetadata<M extends Record<string, unknown>>(
  metadata: M, stop: SessionExplicitStopV1,
): M & Record<typeof SESSION_EXPLICIT_STOP_METADATA_KEY, SessionExplicitStopV1> {
  return { ...metadata, [SESSION_EXPLICIT_STOP_METADATA_KEY]: SessionExplicitStopV1Schema.parse(stop) };
}

/** A completed older resume cannot clear a newer Stop. */
export function clearSessionExplicitStopV1FromMetadata(
  metadata: Record<string, unknown>, expectedRequestId: string,
): Record<string, unknown> {
  const current = readSessionExplicitStopV1FromMetadata(metadata);
  if (!current || 'status' in current || current.requestId !== expectedRequestId) return metadata;
  const next = { ...metadata };
  delete next[SESSION_EXPLICIT_STOP_METADATA_KEY];
  return next;
}
