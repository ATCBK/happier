import {
    type ActionSettingsActionId,
    type ActionSurfaces,
    type ActionsSettingsV1,
} from '@happier-dev/protocol';
import { applyActionPolicyMutation } from '@happier-dev/protocol/actions/actionAudiencePolicy';
import type { ActionPolicySetInput } from '@happier-dev/protocol/actions/actionPolicyActionFamily';

import { getActionSettingsTargetPreferenceSelected } from './actionSettingsTargetSelection';
import {
    getActionTargetApprovalOverride,
    getActionTargetApprovalPolicy,
    isActionSettingsApprovalAction,
    resolveActionSettingsApprovalSurface,
    setActionTargetApprovalRequired,
} from './actionSettingsTargetApproval';
import { resolveActionSettingsTargetDefinition, type ActionSettingsTargetDefinition, type ActionSettingsTargetId } from './actionSettingsTargetDefinitions';

export type ActionSettingsApprovalControlValue = 'off' | 'default' | 'ask_first' | 'allowed';
export type ActionSettingsBooleanControlValue = 'off' | 'on';
export type ActionSettingsTargetControlKind = 'approval' | 'switch' | 'unavailable';

export type ActionSettingsTargetControlState =
    | Readonly<{
        kind: 'approval';
        /** The persisted choice: `default` means this target inherits the policy. */
        value: ActionSettingsApprovalControlValue;
        approvalSurface: keyof ActionSurfaces;
        /**
         * What the canonical Actions approval policy answers for this target with
         * these settings. `value` alone cannot say whether the inherited `default`
         * confirms, and readers must not re-derive that answer: an in-app target is
         * admitted with a present user and inherits no prompt, while the same
         * dangerous Action still confirms on Agent, MCP and CLI.
         */
        approvalRequiredByPolicy: boolean;
        /** Whether an explicit waiver actually suppresses confirmation on this surface. */
        approvalWaivable: boolean;
        /**
         * The inherited default asks only because the Source Control preference does (remote pull and push);
         * the row names that so `Default` is not read as "does not ask".
         */
        approvalAskedBySourceControl: boolean;
    }>
    | Readonly<{
        kind: 'switch';
        value: ActionSettingsBooleanControlValue;
    }>
    | Readonly<{
        kind: 'unavailable';
        value: 'off';
    }>;

type ResolveActionSettingsTargetControlStateParams = Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
    available?: boolean;
    /** The Source Control preference, which is the UI default of the remote pull and push Actions. */
    scmRemoteConfirmPolicy?: unknown;
}>;

type ApplyActionSettingsTargetControlStateParams = Readonly<{
    settings: ActionsSettingsV1;
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
    value: ActionSettingsApprovalControlValue | ActionSettingsBooleanControlValue;
    scmRemoteConfirmPolicy?: unknown;
}>;

function resolveApprovalControlSurface(params: Readonly<{
    actionId: ActionSettingsActionId;
    targetId: ActionSettingsTargetId;
    target?: ActionSettingsTargetDefinition;
    available: boolean;
}>): keyof ActionSurfaces | null {
    if (!params.available || isActionSettingsApprovalAction(params.actionId) || params.actionId === 'capture.view') {
        return null;
    }
    return resolveActionSettingsApprovalSurface(params.actionId, params.targetId, params.target);
}

export function resolveActionSettingsTargetControlState(
    params: ResolveActionSettingsTargetControlStateParams,
): ActionSettingsTargetControlState {
    const available = params.available !== false;
    if (!available) {
        return { kind: 'unavailable', value: 'off' };
    }

    const selected = getActionSettingsTargetPreferenceSelected({
        settings: params.settings,
        actionId: params.actionId,
        targetId: params.targetId,
        ...(params.target ? { target: params.target } : {}),
    });
    const approvalSurface = resolveApprovalControlSurface({
        actionId: params.actionId,
        targetId: params.targetId,
        target: params.target,
        available,
    });

    if (!approvalSurface) {
        return {
            kind: 'switch',
            value: selected ? 'on' : 'off',
        };
    }

    const approvalPolicy = getActionTargetApprovalPolicy({
        settings: params.settings,
        actionId: params.actionId,
        targetId: params.targetId,
        ...(params.target ? { target: params.target } : {}),
        scmRemoteConfirmPolicy: params.scmRemoteConfirmPolicy,
    });

    if (!selected) {
        return {
            kind: 'approval',
            value: 'off',
            approvalSurface,
            ...approvalPolicy,
        };
    }

    const approvalOverride = getActionTargetApprovalOverride({
        settings: params.settings,
        actionId: params.actionId,
        targetId: params.targetId,
        ...(params.target ? { target: params.target } : {}),
    });

    return {
        kind: 'approval',
        value: !approvalPolicy.approvalWaivable ? 'ask_first'
            : approvalOverride === null ? 'default' : approvalOverride ? 'ask_first' : 'allowed',
        approvalSurface,
        ...approvalPolicy,
    };
}

/** Translate the displayed target choice into one admitted semantic policy intent. */
export function resolveActionSettingsTargetPolicyInput(params: ApplyActionSettingsTargetControlStateParams): ActionPolicySetInput {
    let value = params.value;
    if (value === 'ask_first' || value === 'allowed') {
        const inheritedSettings = setActionTargetApprovalRequired({ ...params, approvalRequired: null });
        const inheritedPolicy = getActionTargetApprovalPolicy({ ...params, settings: inheritedSettings });
        // Choosing the inherited answer restores inheritance, including after a waiver.
        if ((value === 'ask_first') === inheritedPolicy.approvalRequiredByPolicy) value = 'default';
    }
    const target = resolveActionSettingsTargetDefinition(params);
    if (target.kind === 'surface') {
        if (value === 'on') return { actionId: params.actionId,
            change: { kind: 'audience_enabled', audience: target.surface, enabled: true } };
        const mode = value === 'allowed' && !getActionTargetApprovalPolicy(params).approvalWaivable ? 'default' : value;
        return { actionId: params.actionId, audience: target.surface, mode };
    }
    if (target.placement === 'slash_command' && value !== 'on') {
        return { actionId: params.actionId,
            change: { kind: 'placement_policy', placement: target.placement, mode: value } };
    }
    return { actionId: params.actionId,
        change: { kind: 'placement', placement: target.placement, enabled: value !== 'off' } };
}

export function applyActionSettingsTargetControlState(params: ApplyActionSettingsTargetControlStateParams): ActionsSettingsV1 {
    return applyActionPolicyMutation(params.settings, resolveActionSettingsTargetPolicyInput(params)).settings;
}
