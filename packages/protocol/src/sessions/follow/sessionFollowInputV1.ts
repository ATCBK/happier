import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';
import { FollowEventV1Schema, isMessageBackedFollowEventV1 } from './sessionFollowPolicyV1.js';
import { SessionFollowSourceMessageV1Schema, SessionFollowSourceRequestsV1Schema } from './sessionFollowSourceOccurrenceV1.js';
import { sha256 } from '@noble/hashes/sha2';
import { encodeBase64 } from '../../crypto/base64.js';
import { ExecutionRunPermissionRequestIdentitySchema } from '../../execution/runs/runPrimitives.js';

const publicFields = { v: z.literal(1), delivery: z.enum(['wake', 'next_turn']) };
export const ExecutionRunFollowSourceV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.literal('execution_run'),
  sessionId: asProtocolZod(SessionIdSchema), runId: z.string().check(z.minLength(1)) }));
const ExecutionRunFollowTerminalOriginalV1Schema = lazyZodSchema(() => z.strictObject({
  source: ExecutionRunFollowSourceV1Schema, terminalEventId: z.string().check(z.minLength(1)),
}));
const ExecutionRunFollowPermissionOriginalV1Schema = lazyZodSchema(() => z.strictObject({
  source: ExecutionRunFollowSourceV1Schema,
  permissionRequests: z.array(ExecutionRunPermissionRequestIdentitySchema).check(z.minLength(1), z.refine(requests =>
    requests.every((request, index) => index === 0 || requests[index - 1]!.requestId < request.requestId),
    { message: 'Permission identities must be sorted and unique' })),
}));
export const ExecutionRunFollowOriginalV1Schema = lazyZodSchema(() => z.union([
  ExecutionRunFollowTerminalOriginalV1Schema, ExecutionRunFollowPermissionOriginalV1Schema,
]));
export const WorkflowRunFollowOriginalV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.strictObject({ kind: z.literal('workflow_run'), runId: z.string().check(z.minLength(1)) }),
  revision: z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)),
}));
const ExecutionRunFollowTerminalEventV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.enum(['finished', 'failed_or_stopped']) }));
const ExecutionRunFollowPermissionEventV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.literal('needs_you'), type: z.literal('approval') }));
export const ExecutionRunFollowEventV1Schema = lazyZodSchema(() => z.union([
  ExecutionRunFollowTerminalEventV1Schema, ExecutionRunFollowPermissionEventV1Schema,
]));
export const ExecutionRunFollowOccurrenceV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ original: ExecutionRunFollowTerminalOriginalV1Schema, event: ExecutionRunFollowTerminalEventV1Schema }),
  z.strictObject({ original: ExecutionRunFollowPermissionOriginalV1Schema, event: ExecutionRunFollowPermissionEventV1Schema }),
]));
/** Workflow revisions retain live attention and committed progress as well as terminal outcomes. */
export const WorkflowRunFollowEventV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.enum(['finished', 'failed_or_stopped', 'update_posted']) }),
  z.strictObject({ kind: z.literal('needs_you'), type: z.enum(['decision', 'approval', 'blocked']) }),
]));
export type WorkflowRunFollowEventV1 = z.infer<typeof WorkflowRunFollowEventV1Schema>;
/** Shared source hint/notice shape. Neither transport can widen the original's source contract. */
export const RunFollowOccurrenceV1Schema = lazyZodSchema(() => z.union([
  ExecutionRunFollowOccurrenceV1Schema,
  z.strictObject({ original: WorkflowRunFollowOriginalV1Schema, event: WorkflowRunFollowEventV1Schema }),
]));
/** Public notice-only intent. Private rule identity and match proof stay in server admission custody. */
export const SessionFollowInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...publicFields,
    original: z.strictObject({ sourceSessionId: asProtocolZod(SessionIdSchema), sourceMessage: SessionFollowSourceMessageV1Schema }),
    event: FollowEventV1Schema,
  }).check(z.refine(value => isMessageBackedFollowEventV1(value.event), {
    path: ['event'], message: 'Question events require an exact source request',
  })),
  z.strictObject({ ...publicFields,
    original: z.strictObject({ sourceSessionId: asProtocolZod(SessionIdSchema), sourceRequests: SessionFollowSourceRequestsV1Schema }),
    requestEvents: z.array(z.strictObject({ requestId: z.string().check(z.minLength(1)),
      event: z.strictObject({ kind: z.literal('needs_you'), type: z.enum(['decision', 'approval', 'blocked']),
        mode: z.optional(z.enum(['wait', 'continue'])), handling: z.optional(z.enum(['person', 'manager'])) }),
    })).check(z.minLength(1)),
  }).check(z.superRefine((value, context) => {
    const ids = new Set(value.original.sourceRequests.requests.map(request => request.requestId));
    for (const [index, request] of value.requestEvents.entries()) {
      if (!ids.delete(request.requestId)) context.addIssue({ code: 'custom', path: ['requestEvents', index], message: 'Each selected original request has exactly one event' });
    }
    if (ids.size) context.addIssue({ code: 'custom', path: ['requestEvents'], message: 'Every selected original request must be represented' });
  })),
  z.strictObject({ ...publicFields,
    original: ExecutionRunFollowTerminalOriginalV1Schema,
    event: ExecutionRunFollowTerminalEventV1Schema,
  }),
  z.strictObject({ ...publicFields,
    original: ExecutionRunFollowPermissionOriginalV1Schema,
    event: ExecutionRunFollowPermissionEventV1Schema,
  }),
  z.strictObject({ ...publicFields,
    original: WorkflowRunFollowOriginalV1Schema,
    event: WorkflowRunFollowEventV1Schema,
  }),
]));
export type SessionFollowInputV1 = z.infer<typeof SessionFollowInputV1Schema>;
export type RunFollowOriginalV1 = Extract<SessionFollowInputV1['original'], { source: unknown }>;
export function isRunFollowOriginalV1(original: SessionFollowInputV1['original']): original is RunFollowOriginalV1 {
  return 'source' in original;
}

/** Current permission-store identities are originals; clearing never fabricates a terminal occurrence. */
export function resolveExecutionRunFollowOccurrenceV1(frontier: Readonly<{
  sessionId: string; runId: string; status: string; terminalEventId: string | null;
  attention?: Readonly<{ kind: 'permission_required'; requestIds: readonly string[];
    requests?: readonly Readonly<{ requestId: string; createdAt: number }>[] }>;
}>): z.infer<typeof ExecutionRunFollowOccurrenceV1Schema> | null {
  const source = { kind: 'execution_run' as const, sessionId: frontier.sessionId, runId: frontier.runId };
  if (frontier.status === 'running') {
    const permissionRequests = [...frontier.attention?.requests ?? []].sort((left, right) =>
      left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0);
    return permissionRequests.length ? { original: { source, permissionRequests }, event: { kind: 'needs_you', type: 'approval' } } : null;
  }
  if (!frontier.terminalEventId) return null;
  const original = { source, terminalEventId: frontier.terminalEventId };
  return frontier.status === 'succeeded' ? { original, event: { kind: 'finished' } }
    : frontier.status === 'failed' || frontier.status === 'cancelled' ? { original, event: { kind: 'failed_or_stopped' } } : null;
}

/** Indexed projection of an existing original identity, independent of routes, batches and publisher fences. */
export function deriveSessionFollowOriginalOccurrenceKeyV1(original: SessionFollowInputV1['original']): string | null {
  const identity = isRunFollowOriginalV1(original)
    ? 'terminalEventId' in original
      ? ['execution_run', original.source.sessionId, original.source.runId, original.terminalEventId]
      : 'permissionRequests' in original
        ? ['execution_run_permission', original.source.sessionId, original.source.runId,
          original.permissionRequests.map(request => [request.requestId, request.createdAt])]
        : ['workflow_run', original.source.runId, original.revision]
    : 'sourceMessage' in original
    ? ['message', original.sourceSessionId, original.sourceMessage.localId, original.sourceMessage.seq]
    : original.sourceRequests.requests.length === 1
      ? ['request', original.sourceSessionId, original.sourceRequests.requests[0]!.requestId,
        original.sourceRequests.requests[0]!.createdAt, original.sourceRequests.requests[0]!.turnId ?? null]
      : null;
  // Older development batches may represent several originals; no scalar
  // projection or acceptance proof may be invented for those retained rows.
  return identity === null ? null : encodeBase64(sha256(new TextEncoder().encode(JSON.stringify(identity))), 'base64url');
}

/** Retry identity on the existing destination-scoped Pending input, not another occurrence identity. */
export function deriveSessionFollowInputLocalIdV1(input: Readonly<{
  destinationSessionId: string; original: SessionFollowInputV1['original'];
}>): string {
  const key = deriveSessionFollowOriginalOccurrenceKeyV1(input.original);
  if (key === null) throw new TypeError('A Follow input must represent one original occurrence');
  // Pending localId is already scoped by destination Session in its unique key.
  return `follow-original:${key}`;
}
