import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { isActionApprovalWaivable } from './actionApprovalPolicy.js';
import { isActionEnabledByActionsSettings, normalizeActionsSettingsV1, setActionApprovalOverride,
  normalizeActionSettingsActionId, isActionSettingsOptInPlacement,
  type ActionsSettingsV1, type ActionSettingsActionId, type ActionSettingsOverride, type ActionSurfaceKey } from './actionSettings.js';
import type { ActionUiPlacement } from './actionUiPlacements.js';
import type { ActionAudiencePolicyMode, ActionAudiencePolicyResult, ActionPolicySetInput, ActionPolicySetResult } from './actionPolicyActionFamily.js';

/** One audience preference; global enablement and every neighbouring preference remain intact. */
export function setActionAudiencePolicy(settings: ActionsSettingsV1, actionId: string,
  audience: ActionSurfaceKey, mode: ActionAudiencePolicyMode): ActionsSettingsV1 {
  const admittedId = normalizeActionSettingsActionId(actionId);
  if (!admittedId || admittedId !== actionId) throw new Error('invalid_action_id');
  const selected = setActionAudienceEnabled(settings, admittedId, audience, mode !== 'off');
  return setActionAudienceApproval(selected, admittedId, audience, mode);
}

function setActionAudienceApproval(settings: ActionsSettingsV1, admittedId: ActionSettingsActionId,
  audience: ActionSurfaceKey, mode: ActionAudiencePolicyMode): ActionsSettingsV1 {
  const host = ActionIdSchema.safeParse(admittedId);
  const waivable = !host.success || isActionApprovalWaivable(getActionSpec(host.data));
  return setActionApprovalOverride({ settings, actionId: admittedId, surface: audience,
    approvalRequired: mode === 'allowed' && waivable ? false : mode === 'ask_first' ? true : null });
}

function setActionPlacementEnabled(settings: ActionsSettingsV1, actionId: ActionSettingsActionId,
  placement: ActionUiPlacement, enabled: boolean): ActionsSettingsV1 {
  const normalized = normalizeActionsSettingsV1(settings);
  const prior = normalized.actions[actionId];
  const row: ActionSettingsOverride = prior ?? { enabledPlacements: [], disabledPlacements: [], disabledSurfaces: [],
    approvalRequiredSurfaces: [], toolExposureModes: {} };
  const unique = (values: readonly ActionUiPlacement[]) => [...new Set(values)].sort();
  const next = isActionSettingsOptInPlacement(placement) ? {
    ...row,
    disabledPlacements: row.disabledPlacements.filter(value => value !== placement),
    enabledPlacements: enabled ? unique([...row.enabledPlacements, placement])
      : row.enabledPlacements.filter(value => value !== placement),
  } : { ...row, disabledPlacements: enabled ? row.disabledPlacements.filter(value => value !== placement)
    : unique([...row.disabledPlacements, placement]) };
  return { ...normalized, actions: { ...normalized.actions, [actionId]: next } };
}

/** One admitted semantic policy edit, rebased by the Account CAS owner. */
export function applyActionPolicyMutation(settings: ActionsSettingsV1, input: ActionPolicySetInput): Readonly<{
  settings: ActionsSettingsV1;
  result: ActionPolicySetResult;
}> {
  if (!('change' in input)) {
    const next = setActionAudiencePolicy(settings, input.actionId, input.audience, input.mode);
    return { settings: next, result: readActionAudiencePolicy(next, input.actionId, input.audience) };
  }
  const actionId = normalizeActionSettingsActionId(input.actionId);
  if (!actionId || actionId !== input.actionId) throw new Error('invalid_action_id');
  const normalized = normalizeActionsSettingsV1(settings);
  const prior = normalized.actions[actionId];
  const row: ActionSettingsOverride = prior ?? { enabledPlacements: [], disabledPlacements: [], disabledSurfaces: [],
    approvalRequiredSurfaces: [], toolExposureModes: {} };
  const changed = (next: typeof row): ActionsSettingsV1 => ({ ...normalized, actions: { ...normalized.actions, [actionId]: next } });
  const change = input.change;
  switch (change.kind) {
    case 'enabled': {
      const next = { ...row };
      if (change.enabled) delete next.enabled;
      else next.enabled = false;
      return { settings: changed(next), result: input };
    }
    case 'audience_enabled':
      return { settings: setActionAudienceEnabled(normalized, actionId, change.audience, change.enabled), result: input };
    case 'placement':
      return { settings: setActionPlacementEnabled(normalized, actionId, change.placement, change.enabled), result: input };
    case 'placement_policy': {
      const selected = setActionPlacementEnabled(normalized, actionId, change.placement, change.mode !== 'off');
      return { settings: setActionAudienceApproval(selected, actionId, 'ui', change.mode), result: input };
    }
    case 'tool_exposure': {
      const host = ActionIdSchema.safeParse(actionId);
      if (!host.success) return { settings: normalized, result: input };
      const spec = getActionSpec(host.data);
      if (!spec.bindings?.mcpToolName || spec.surfaces[change.surface] !== true) return { settings: normalized, result: input };
      const toolExposureModes = { ...row.toolExposureModes };
      if (change.mode === 'default') delete toolExposureModes[change.surface];
      else toolExposureModes[change.surface] = change.mode;
      return { settings: changed({ ...row, toolExposureModes }), result: input };
    }
    case 'plugin_host_capture': {
      const remaining = normalized.pluginHostCaptureApprovalWaived?.filter(id => id !== change.pluginId) ?? [];
      return { settings: { ...normalized, pluginHostCaptureApprovalWaived: change.approvalRequired
        ? remaining : [...remaining, change.pluginId] }, result: input };
    }
  }
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
