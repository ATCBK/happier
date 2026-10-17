import type { ActionId, ActionSettingsActionId } from '@happier-dev/protocol';
import { isActionEnabledByActionsSettings, normalizeActionsSettingsV1, type ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';

import { isExecutionRunsFeatureAction } from '@/sync/domains/actions/isExecutionRunsFeatureAction';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';
import { normalizeScmRemoteConfirmPolicy, shouldConfirmRemoteOperation } from '@/scm/settings/remoteConfirmationPolicy';
import { storage } from '@/sync/domains/state/storage';

// Settings writers replace changed policy objects; reconcileSettingsReferences preserves
// unchanged ones. Share normalization across row/admission checks for that revision,
// without retaining policies after their settings snapshots are released.
const normalizedActionsSettingsByRevision = new WeakMap<object, ActionsSettingsV1>();

export function resolveActionsSettingsV1FromState(state: Readonly<{ settings?: unknown }>): ActionsSettingsV1 {
    const raw = (state.settings as { actionsSettingsV1?: unknown } | null | undefined)?.actionsSettingsV1;
    if (raw === null || typeof raw !== 'object') return normalizeActionsSettingsV1(raw);
    const existing = normalizedActionsSettingsByRevision.get(raw);
    if (existing) return existing;
    const normalized = normalizeActionsSettingsV1(raw);
    normalizedActionsSettingsByRevision.set(raw, normalized);
    return normalized;
}

export function isActionEnabledInState(
    state: Readonly<{ settings?: unknown }>,
    actionId: ActionId,
    ctx?: Readonly<{ surface?: string | null; placement?: string | null }>,
): boolean {
    const settingsState = ((state as any)?.settings ?? {}) as any;
    if (isExecutionRunsFeatureAction(actionId) && !resolveLocalFeaturePolicyEnabled('execution.runs', settingsState)) {
        return false;
    }

    const settings = resolveActionsSettingsV1FromState(state);
    return isActionEnabledByActionsSettings(actionId, settings as any, ctx as any);
}

type ApprovalContext = Parameters<typeof isApprovalRequiredByActionsSettings>[2];

/**
 * The person's Source Control preference (`scmRemoteConfirmPolicy`, kept from 0.2) is the UI default
 * confirmation of the remote pull and push Actions. It is a default like the protocol's own: a present
 * person's UI press asks once, in place, unless the person already answered this exact press in a dialog
 * of their own (`presentUserConfirmation`) or set the Action to Allowed. An explicit Ask first stays the
 * Action policy's own approval, so the two never stack.
 */
function scmRemotePreferenceAsks(
    actionId: ActionSettingsActionId,
    accountSettings: Readonly<{ scmRemoteConfirmPolicy?: unknown; actionsSettingsV1?: unknown }> | null | undefined,
    ctx: ApprovalContext,
): boolean {
    const kind = actionId === 'scm.remote.pull' ? 'pull' : actionId === 'scm.remote.push' ? 'push' : null;
    if (!kind || ctx?.surface !== 'ui' || ctx.authority !== 'present_user') return false;
    if (ctx.presentUserConfirmation?.actionId === actionId) return false;
    if (resolveActionsSettingsV1FromState({ settings: accountSettings }).approvalWaivedSurfaces?.[actionId]?.includes('ui')) return false;
    return shouldConfirmRemoteOperation(normalizeScmRemoteConfirmPolicy(accountSettings?.scmRemoteConfirmPolicy), kind);
}

/**
 * Whether an Action invocation needs approval under the person's Account settings: the Action policy
 * (Settings → Actions) plus the Source Control preference as the remote Actions' UI default. The one
 * resolver for the executor's approval hook and every UI prediction of it.
 */
export function isActionApprovalRequiredByAccountSettings(
    actionId: ActionSettingsActionId,
    accountSettings: Readonly<{ scmRemoteConfirmPolicy?: unknown; actionsSettingsV1?: unknown }> | null | undefined,
    ctx: ApprovalContext,
    options?: Readonly<{ defaultSafety?: Parameters<typeof isApprovalRequiredByActionsSettings>[3]; defaultUiConfirmation?: boolean; contributedApprovalDefault?: boolean; input?: unknown }>,
): boolean {
    return isApprovalRequiredByActionsSettings(
        actionId, resolveActionsSettingsV1FromState({ settings: accountSettings }), ctx,
        options?.defaultSafety, options?.contributedApprovalDefault, options?.input, options?.defaultUiConfirmation,
    ) || scmRemotePreferenceAsks(actionId, accountSettings, ctx);
}

/** The person's own Ask-first policy for one Action on one invoking surface. */
export function isActionApprovalRequiredInState(
    state: Readonly<{ settings?: unknown }>,
    actionId: ActionSettingsActionId,
    ctx: ApprovalContext,
    contributedApprovalDefault?: boolean,
): boolean {
    return isActionApprovalRequiredByAccountSettings(
        actionId, (state as { settings?: Record<string, unknown> }).settings, ctx, { contributedApprovalDefault });
}

/** A scoped control reads the same captured Home settings as the UI Action host. */
export async function isActionApprovalRequiredForHome(
    actionId: ActionId,
    ctx: Parameters<typeof isApprovalRequiredByActionsSettings>[2],
    serverId?: string | null,
): Promise<boolean> {
    if (!serverId) return isActionApprovalRequiredInState(storage.getState(), actionId, ctx);
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const settings = await account.readSettings();
        account.assertCurrent();
        return isActionApprovalRequiredInState({ settings }, actionId, ctx);
    } finally {
        account.dispose();
    }
}
