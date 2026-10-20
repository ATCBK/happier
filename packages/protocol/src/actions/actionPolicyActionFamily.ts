import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionSurfaceSchema, ActionToolExposureModeSchema, ActionToolExposureSurfaceSchema } from './metadata.js';
import { ActionUiPlacementSchema } from './actionUiPlacements.js';
import { normalizeActionSettingsActionId } from './actionSettings.js';
export { ACTION_POLICY_ACTION_IDS, isActionPolicyActionId, type ActionPolicyActionId } from './actionPolicyActionIds.js';

export type ActionAudiencePolicyMode = 'allowed' | 'ask_first' | 'off' | 'default';
const actionId = lazyZodSchema(() => z.string().check(z.refine(value => normalizeActionSettingsActionId(value) === value)));
const target = { actionId, audience: lazyZodSchema(() => z.keyof(ActionSurfaceSchema)) };
const mode = lazyZodSchema(() => z.enum(['allowed', 'ask_first', 'off', 'default']));
const result = lazyZodSchema(() => z.strictObject({ ...target, mode, actionEnabled: z.boolean(), enabled: z.boolean() }));
const changed = lazyZodSchema(() => z.union([
  z.strictObject({ actionId, change: z.union([
    z.strictObject({ kind: z.literal('enabled'), enabled: z.boolean() }),
    z.strictObject({ kind: z.literal('audience_enabled'), audience: z.keyof(ActionSurfaceSchema), enabled: z.boolean() }),
    z.strictObject({ kind: z.literal('placement'), placement: ActionUiPlacementSchema, enabled: z.boolean() }),
    z.strictObject({ kind: z.literal('placement_policy'), placement: z.literal('slash_command'), mode }),
    z.strictObject({ kind: z.literal('tool_exposure'), surface: ActionToolExposureSurfaceSchema,
      mode: z.union([ActionToolExposureModeSchema, z.literal('default')]) }),
  ]) }),
  z.strictObject({ actionId: z.literal('capture.view'), change: z.strictObject({
    kind: z.literal('plugin_host_capture'), pluginId: z.string().check(z.minLength(1)), approvalRequired: z.boolean(),
  }) }),
]));
export const ActionPolicyInputSchemas = {
  'actions.policy.get': lazyZodSchema(() => z.strictObject(target)),
  'actions.policy.set': lazyZodSchema(() => z.union([z.strictObject({ ...target, mode }), changed])),
  'actions.policy.reset': lazyZodSchema(() => z.strictObject(target)),
} as const;
export const ActionPolicyOutputSchemas = {
  'actions.policy.get': result,
  'actions.policy.set': lazyZodSchema(() => z.union([result, changed])),
  'actions.policy.reset': result,
} as const;
export type ActionAudiencePolicyResult = z.infer<typeof result>;
export type ActionPolicySetInput = z.infer<typeof ActionPolicyInputSchemas['actions.policy.set']>;
export type ActionPolicySetResult = z.infer<typeof ActionPolicyOutputSchemas['actions.policy.set']>;
