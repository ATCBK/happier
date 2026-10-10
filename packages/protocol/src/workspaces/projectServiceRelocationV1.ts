import { z } from 'zod';

import { ActionOperationSnapshotV1Schema } from '../actions/operations/v1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { LocalServiceActionTargetV1Schema } from '../local/services/actions/v1.js';
import { ProjectServicePlacementGetV1Schema, ProjectServicePlacementSetV1Schema } from './projectServicePlacementV1.js';
import { ProjectExecutionChoiceV1Schema } from './projectWorkerPreferencesV1.js';

/** Reuses Local Services' exact managed identity; input never establishes control authority. */
export const ProjectServiceRelocateInputV1Schema = lazyZodSchema(() => ProjectServicePlacementGetV1Schema.extend({
  requestId: ActionOperationSnapshotV1Schema.shape.requestId.unwrap(),
  currentTarget: LocalServiceActionTargetV1Schema.options[1],
  /** The sibling-preserving placement CAS that must settle before native Stop. */
  desiredPlacement: ProjectServicePlacementSetV1Schema,
  destination: ProjectExecutionChoiceV1Schema,
  /** Exact target and native effect basis reviewed before approval; Auto is never re-ranked later. */
  selectedTarget: z.object({ machineId: z.string().min(1) }).strict(),
}).strict());
export type ProjectServiceRelocateInputV1 = z.infer<typeof ProjectServiceRelocateInputV1Schema>;

export const ProjectServiceRelocateResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted'), operation: ActionOperationSnapshotV1Schema }).strict(),
  z.object({ status: z.enum(['moved', 'unchanged']), currentTarget: LocalServiceActionTargetV1Schema.options[1] }).strict(),
  z.object({ status: z.enum(['refused', 'unsupported']), reasonCode: z.string().min(1) }).strict(),
]));
export type ProjectServiceRelocateResultV1 = z.infer<typeof ProjectServiceRelocateResultV1Schema>;
