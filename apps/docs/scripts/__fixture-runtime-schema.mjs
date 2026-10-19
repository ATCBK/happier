import * as z from 'zod/mini';
import { AGENT_SESSION_RUNTIME_EVENT_KINDS_V1 } from '../../../packages/protocol/dist/runtime/agentSessionV1.js';

// Exercise the same native Core union/literal boundary as Protocol, including
// one newly introduced kind that the reference must refuse to silently omit.
export const AgentSessionRuntimeEventV1Schema = z.union([
  z.discriminatedUnion('kind', [
    ...AGENT_SESSION_RUNTIME_EVENT_KINDS_V1.filter(kind => kind !== 'context-compaction')
      .map(kind => z.strictObject({ kind: z.literal(kind) })),
    z.strictObject({ kind: z.literal('brand-new-kind') }),
  ]),
  z.discriminatedUnion('phase', [
    z.strictObject({ kind: z.literal('context-compaction'), phase: z.literal('started') }),
    z.strictObject({ kind: z.literal('context-compaction'), phase: z.literal('completed') }),
  ]),
]);
