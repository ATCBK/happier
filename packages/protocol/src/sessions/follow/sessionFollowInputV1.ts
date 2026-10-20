import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';
import { FollowEventV1Schema, isMessageBackedFollowEventV1 } from './sessionFollowPolicyV1.js';
import { SessionFollowSourceMessageV1Schema, SessionFollowSourceRequestsV1Schema } from './sessionFollowSourceOccurrenceV1.js';
import { sha256 } from '@noble/hashes/sha2';
import { encodeBase64 } from '../../crypto/base64.js';

const publicFields = { v: z.literal(1), delivery: z.enum(['wake', 'next_turn']) };
export const ExecutionRunFollowOriginalV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.strictObject({ kind: z.literal('execution_run'), sessionId: asProtocolZod(SessionIdSchema),
    runId: z.string().check(z.minLength(1)) }),
  terminalEventId: z.string().check(z.minLength(1)),
}));
export const WorkflowRunFollowOriginalV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.strictObject({ kind: z.literal('workflow_run'), runId: z.string().check(z.minLength(1)) }),
  revision: z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)),
}));
export const ExecutionRunFollowEventV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.enum(['finished', 'failed_or_stopped']) }));
/** Workflow revisions retain live attention and committed progress as well as terminal outcomes. */
export const WorkflowRunFollowEventV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.enum(['finished', 'failed_or_stopped', 'update_posted']) }),
  z.strictObject({ kind: z.literal('needs_you'), type: z.enum(['decision', 'approval', 'blocked']) }),
]));
export type WorkflowRunFollowEventV1 = z.infer<typeof WorkflowRunFollowEventV1Schema>;
/** Shared source hint/notice shape. Neither transport can widen the original's source contract. */
export const RunFollowOccurrenceV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ original: ExecutionRunFollowOriginalV1Schema, event: ExecutionRunFollowEventV1Schema }),
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
    original: ExecutionRunFollowOriginalV1Schema,
    event: ExecutionRunFollowEventV1Schema,
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

/** Indexed projection of an existing original identity, independent of routes, batches and publisher fences. */
export function deriveSessionFollowOriginalOccurrenceKeyV1(original: SessionFollowInputV1['original']): string | null {
  const identity = isRunFollowOriginalV1(original)
    ? 'terminalEventId' in original
      ? ['execution_run', original.source.sessionId, original.source.runId, original.terminalEventId]
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
