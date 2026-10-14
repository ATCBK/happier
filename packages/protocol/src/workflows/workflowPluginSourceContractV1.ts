import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { WorkflowDefinitionV1Schema } from './workflowV1.js';
import { WorkflowDefinitionRefV1StringSchema, parseWorkflowDefinitionRefV1 } from './workflowDefinitionRefV1.js';

/** Serving descriptor codec, independent of catalog semantic normalization. */
export const WorkflowPluginSourceV1Schema = lazyZodSchema(() => z.strictObject({
  workflow: WorkflowDefinitionRefV1StringSchema,
  pluginId: z.string().check(z.minLength(1)),
  version: z.string().check(z.minLength(1)),
  title: z.string().check(z.minLength(1)),
  description: z.optional(z.string()),
  definition: WorkflowDefinitionV1Schema,
}).check(z.superRefine((source, context) => {
  const ref = parseWorkflowDefinitionRefV1(source.workflow);
  if (ref?.kind !== 'plugin' || ref.contribution.pluginId !== source.pluginId) {
    context.addIssue({ code: 'custom', path: ['workflow'], message: 'Workflow must belong to its declared plugin' });
  }
})));
export type WorkflowPluginSourceV1 = z.infer<typeof WorkflowPluginSourceV1Schema>;
export type WorkflowPluginSourceReaderV1 = () => readonly WorkflowPluginSourceV1[] | Promise<readonly WorkflowPluginSourceV1[]>;
