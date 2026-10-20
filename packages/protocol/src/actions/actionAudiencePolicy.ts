import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { isActionApprovalWaivable } from './actionApprovalPolicy.js';
import { isActionEnabledByActionsSettings, normalizeActionsSettingsV1, setActionApprovalOverride,
  normalizeActionSettingsActionId,
  type ActionsSettingsV1, type ActionSettingsActionId, type ActionSurfaceKey } from './actionSettings.js';
import type { ActionAudiencePolicyMode, ActionAudiencePolicyResult } from './actionPolicyActionFamily.js';

/** One audience preference; global enablement and every neighbouring preference remain intact. */
export function setActionAudiencePolicy(settings: ActionsSettingsV1, actionId: string,
  audience: ActionSurfaceKey, mode: ActionAudiencePolicyMode): ActionsSettingsV1 {
  const admittedId = normalizeActionSettingsActionId(actionId);
  if (!admittedId || admittedId !== actionId) throw new Error('invalid_action_id');
  const selected = setActionAudienceEnabled(settings, admittedId, audience, mode !== 'off');
  const host = ActionIdSchema.safeParse(admittedId);
  const waivable = !host.success || isActionApprovalWaivable(getActionSpec(host.data));
  return setActionApprovalOverride({ settings: selected, actionId: admittedId, surface: audience,
    approvalRequired: mode === 'allowed' && waivable ? false : mode === 'ask_first' ? true : null });
}

/** The Settings switch and the policy Action share the same audience enablement writer. */
export function setActionAudienceEnabled(settings: ActionsSettingsV1, actionId: ActionSettingsActionId,
  audience: ActionSurfaceKey, enabled: boolean): ActionsSettingsV1 {
  const normalized = normalizeActionsSettingsV1(settings);
  const prior = normalized.actions[actionId];
  const disabledSurfaces = prior?.disabledSurfaces.filter(surface => surface !== audience) ?? [];
  if (!enabled) disabledSurfaces.push(audience);
  if (!prior && enabled) return normalized;
  return { ...normalized, actions: { ...normalized.actions,
    [actionId]: { ...prior, enabledPlacements: prior?.enabledPlacements ?? [], disabledPlacements: prior?.disabledPlacements ?? [],
      approvalRequiredSurfaces: prior?.approvalRequiredSurfaces ?? [], toolExposureModes: prior?.toolExposureModes ?? {}, disabledSurfaces },
  } };
}

export function readActionAudiencePolicy(settings: ActionsSettingsV1, actionId: string, audience: ActionSurfaceKey): ActionAudiencePolicyResult {
  const admittedId = normalizeActionSettingsActionId(actionId);
  if (!admittedId || admittedId !== actionId) throw new Error('invalid_action_id');
  const normalized = normalizeActionsSettingsV1(settings);
  const row = normalized.actions[actionId];
  const mode: ActionAudiencePolicyMode = row?.disabledSurfaces.includes(audience) ? 'off'
    : row?.approvalRequiredSurfaces.includes(audience) ? 'ask_first'
    : normalized.approvalWaivedSurfaces?.[actionId]?.includes(audience) ? 'allowed' : 'default';
  return { actionId, audience, mode, actionEnabled: row?.enabled !== false,
    enabled: isActionEnabledByActionsSettings(admittedId, normalized, { surface: audience }) };
}
