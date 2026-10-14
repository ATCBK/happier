import { t } from '@/text';
import type { UsageCostMode } from '@/sync/api/account/usageAnalytics';

/** Labels for witnessed money facts; selection remains at the Protocol cost owner. */
export function usageCostKindPhrase(kind: string): string {
    switch (kind) {
        case 'api_equivalent':
        case 'provider_reported_api_equivalent': return t('usage.board.page.kindApiEquivalent');
        case 'invoice': return t('usage.board.page.kindInvoice');
        case 'reported':
        case 'provider_reported': return t('usage.board.page.kindReported');
        case 'estimated':
        case 'pricing_estimate': return t('usage.board.page.kindEstimated');
        case 'unpriced': return t('usage.board.page.kindUnpriced');
        default: return t('usage.board.page.kindMixed');
    }
}

export function resolveUsageCostModeLabel(input: Readonly<{
    availableCostModes: readonly UsageCostMode[];
    mode: UsageCostMode;
}>): string {
    if (input.availableCostModes.length === 1 && input.availableCostModes[0] === 'auto') {
        return t('usage.auto');
    }

    if (input.mode === 'reported') {
        return t('usage.reported');
    }
    if (input.mode === 'estimated') {
        return t('usage.estimated');
    }
    if (input.mode === 'api_equivalent') {
        return t('usage.board.page.factApiEquivalent');
    }
    return t('usage.auto');
}
