import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ExecutableParticipantSelectionV1Schema } from '../discussions/executableParticipants.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { WorkflowBlockIdSchema } from './workflowReferenceV1.js';

export const WorkflowDiscussionRoundProjectInputV1Schema = lazyZodSchema(() => z.strictObject({
  collections: z.array(WorkflowBlockIdSchema).check(z.minLength(1)),
  phase: z.optional(z.enum(['prepare', 'complete'])),
  rosterInput: z.optional(z.string()),
  previousProjectionBlockId: z.optional(WorkflowBlockIdSchema),
  preparationBlockId: z.optional(WorkflowBlockIdSchema),
}));
export const WorkflowDiscussionRoundProjectResultV1Schema = lazyZodSchema(() => z.strictObject({
  allPassed: z.boolean(),
  hasNext: z.boolean(),
  throughSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
  context: z.optional(StrictJsonValueSchema),
  nextParticipants: z.array(ExecutableParticipantSelectionV1Schema),
  outcomeReferences: z.array(z.strictObject({
    runId: z.string(), invocationRecordId: z.string(),
    participant: ExecutableParticipantSelectionV1Schema,
    executionSessionId: z.optional(z.string()),
    kind: z.enum(['answer', 'pass', 'failed', 'cancelled', 'declined', 'terminal_no_result']),
    result: z.optional(StrictJsonValueSchema),
    reply: z.optional(StrictJsonValueSchema),
  })),
}));
