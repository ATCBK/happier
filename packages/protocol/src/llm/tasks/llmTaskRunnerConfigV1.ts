import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { BackendTargetRefSchema } from '../../backends/targets/backendTargetRef.js';
import { readBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import { ProviderBoundModelRefSchema } from '../../providers/selection/v1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

export const LlmTaskPermissionModeSchema = lazyZodSchema(() => z.enum([
  'no_tools',
  'read_only',
  'workspace_write',
  'full',
]));
export type LlmTaskPermissionMode = z.infer<typeof LlmTaskPermissionModeSchema>;

export const LlmTaskRunnerConfigV1WriteSchema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    modelSelection: ProviderBoundModelRefSchema.check(z.refine(value => value.providerConnectionId === null, 'Task runner configuration currently supports native Agent models')),
    permissionMode: z.optional(LlmTaskPermissionModeSchema),
  }));

const StoredRunnerSchema = createStoredReadSchema(LlmTaskRunnerConfigV1WriteSchema);
const StoredPredecessorTargetSchema = createStoredReadSchema(BackendTargetRefSchema);
/** Forward reader for the real 0.2 runner setting; writers emit only modelSelection. */
export const LlmTaskRunnerConfigV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, 'modelSelection')) return record;
  const target = StoredPredecessorTargetSchema.safeParse(record.backendTarget);
  if (!target.success) return value;
  const agentTargetKey = readBackendTargetKeyV2(target.data);
  if (!agentTargetKey) return value;
  return { v: record.v, modelSelection: {
    agentTargetKey,
    providerConnectionId: null,
    modelId: record.modelId === undefined ? 'default' : typeof record.modelId === 'string' ? record.modelId.trim() : record.modelId,
  }, ...(record.permissionMode === undefined ? {} : { permissionMode: record.permissionMode }) };
}), StoredRunnerSchema));

export type LlmTaskRunnerConfigV1 = z.infer<typeof LlmTaskRunnerConfigV1Schema>;
