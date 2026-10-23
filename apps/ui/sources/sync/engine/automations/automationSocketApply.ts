import type { AutomationRefreshOptions } from './syncAutomations';

export function isAutomationSocketUpdateType(type: string): boolean {
    return (
        type === 'automation-upsert'
        || type === 'automation-delete'
        || type === 'automation-run-updated'
        || type === 'automation-assignment-updated'
        || type === 'automation-source-status-updated'
    );
}

export function applyAutomationSocketUpdate(params: {
    updateType: string;
    invalidateAutomations: (options?: AutomationRefreshOptions) => void;
    invalidateAutomationsCoalesced?: (options?: AutomationRefreshOptions) => void;
}): boolean {
    if (!isAutomationSocketUpdateType(params.updateType)) {
        return false;
    }
    const invalidate = params.invalidateAutomationsCoalesced ?? params.invalidateAutomations;
    // Source/catalog status and consumed no-Run budgets change summaries, not Runs.
    if (params.updateType === 'automation-source-status-updated') invalidate({ summariesOnly: true });
    else invalidate();
    return true;
}
