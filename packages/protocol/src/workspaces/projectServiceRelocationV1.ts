import { z } from 'zod/mini';

import { ActionOperationSnapshotV1Schema } from '../actions/operations/v1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { LocalServiceActionTargetV1Schema } from '../local/services/actions/v1.js';
import { ProjectServicePlacementGetV1Schema, ProjectServicePlacementSetV1Schema } from './projectServicePlacementV1.js';
import { ProjectExecutionChoiceV1Schema } from './projectWorkerPreferencesV1.js';

/** Reuses Local Services' exact managed identity; input never establishes control authority. */
export const ProjectServiceRelocateInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ProjectServicePlacementGetV1Schema, {
  requestId: ActionOperationSnapshotV1Schema.shape.requestId._zod.def.innerType,
  currentTarget: LocalServiceActionTargetV1Schema._zod.def.options[1],
  /** The sibling-preserving placement CAS that must settle before native Stop. */
  desiredPlacement: ProjectServicePlacementSetV1Schema,
  destination: ProjectExecutionChoiceV1Schema,
  /** Exact target and native effect basis reviewed before approval; Auto is never re-ranked later. */
  selectedTarget: z.strictObject({ machineId: z.string().check(z.minLength(1)) }),
})));
export type ProjectServiceRelocateInputV1 = z.infer<typeof ProjectServiceRelocateInputV1Schema>;

export const ProjectServiceRelocateResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('accepted'), operation: ActionOperationSnapshotV1Schema }),
  z.strictObject({ status: z.enum(['moved', 'unchanged']), currentTarget: LocalServiceActionTargetV1Schema._zod.def.options[1] }),
  z.strictObject({ status: z.enum(['refused', 'unsupported']), reasonCode: z.string().check(z.minLength(1)) }),
]));
export type ProjectServiceRelocateResultV1 = z.infer<typeof ProjectServiceRelocateResultV1Schema>;
