import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { PromptInvocationAvailabilityV1Schema, PromptInvocationBehaviorV1Schema, PromptInvocationTargetV1Schema } from '../prompts/library/promptInvocationsV1.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

export const PromptInvocationCreateInputSchema = lazyZodSchema(() => z.strictObject({
  token: z.string().check(z.trim(), z.minLength(1)), title: z.string().check(z.trim(), z.minLength(1)), target: PromptInvocationTargetV1Schema,
  behavior: z.optional(PromptInvocationBehaviorV1Schema), allowArgs: z.optional(z.boolean()), availableIn: z.optional(PromptInvocationAvailabilityV1Schema),
}));
export const PromptInvocationCreateOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('updated'), invocationId: z.string().check(z.minLength(1)), token: z.string().check(z.minLength(1)), revision: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.literal('invalid'), reason: z.enum(['invalid', 'reserved', 'actionCollision', 'duplicate']) }),
  z.strictObject({ status: z.literal('conflict'), revision: z.number().check(z.int()) }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.string().check(z.minLength(1)) }),
]));
export const PROMPT_INVOCATION_CREATE_ACTION_SPECS = [{
  id: 'prompts.invocation.create', approval: {result: 'required'}, title: 'Create a prompt shortcut',
  description: 'Add a slash shortcut to an existing prompt document in the admitted Account. Uses the current invocations catalog, canonical token validation and revision CAS; conflicts are not retried.',
  safety: 'danger', sideEffectClass: 'write', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
  bindings: { mcpToolName: 'prompts_invocation_create' },
  inputSchema: PromptInvocationCreateInputSchema, outputSchema: PromptInvocationCreateOutputSchema,
  inputHints: { fields: [
    { path: 'token', title: 'Slash shortcut', widget: 'text', required: true },
    { path: 'title', title: 'Title', widget: 'text', required: true },
    { path: 'target', title: 'Prompt document reference', widget: 'json', required: true },
    { path: 'behavior', title: 'Insertion behavior', widget: 'text' },
    { path: 'allowArgs', title: 'Allow arguments', widget: 'boolean' },
    { path: 'availableIn', title: 'Availability', widget: 'text' },
  ] },
}] as const satisfies readonly PreNormalizedActionSpec[];
