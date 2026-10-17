import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionSurfaceSchema } from './metadata.js';
import { normalizeActionSettingsActionId } from './actionSettings.js';
export { ACTION_POLICY_ACTION_IDS, isActionPolicyActionId, type ActionPolicyActionId } from './actionPolicyActionIds.js';

export type ActionAudiencePolicyMode = 'allowed' | 'ask_first' | 'off' | 'default';
const actionId = lazyZodSchema(() => z.string().check(z.refine(value => normalizeActionSettingsActionId(value) === value)));
const target = { actionId, audience: lazyZodSchema(() => z.keyof(ActionSurfaceSchema)) };
const mode = lazyZodSchema(() => z.enum(['allowed', 'ask_first', 'off', 'default']));
const result = lazyZodSchema(() => z.strictObject({ ...target, mode, actionEnabled: z.boolean(), enabled: z.boolean() }));
export const ActionPolicyInputSchemas = {
  'actions.policy.get': lazyZodSchema(() => z.strictObject(target)),
  'actions.policy.set': lazyZodSchema(() => z.strictObject({ ...target, mode })),
  'actions.policy.reset': lazyZodSchema(() => z.strictObject(target)),
} as const;
export const ActionPolicyOutputSchemas = {
  'actions.policy.get': result, 'actions.policy.set': result, 'actions.policy.reset': result,
} as const;
export type ActionAudiencePolicyResult = z.infer<typeof result>;
