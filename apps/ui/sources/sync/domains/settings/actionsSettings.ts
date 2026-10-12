import type { ActionId, ActionSettingsActionId } from '@happier-dev/protocol';
import { isActionEnabledByActionsSettings, normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';

import { isExecutionRunsFeatureAction } from '@/sync/domains/actions/isExecutionRunsFeatureAction';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';
import { storage } from '@/sync/domains/state/storage';

export function resolveActionsSettingsV1FromState(state: Readonly<{ settings?: unknown }>) {
    return normalizeActionsSettingsV1((state as any)?.settings?.actionsSettingsV1);
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

/** The person's own Ask-first policy for one Action on one invoking surface. */
export function isActionApprovalRequiredInState(
    state: Readonly<{ settings?: unknown }>,
    actionId: ActionSettingsActionId,
    ctx: Parameters<typeof isApprovalRequiredByActionsSettings>[2],
    contributedApprovalDefault?: boolean,
): boolean {
    return isApprovalRequiredByActionsSettings(actionId, resolveActionsSettingsV1FromState(state), ctx, undefined, contributedApprovalDefault);
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
