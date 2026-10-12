import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';

import { normalizeMachineSummaryMetrics } from './machineSummarySettingModel';

/**
 * The shown Machine summary metrics, exposed to `settings.get/set` through the one normalizer the
 * reader and writer use (known ids, once each, canonical order). An empty list is kept: names only (R42.6).
 */
export const machineSummaryMetricsStorageBinding: SettingStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write',
    read: local => normalizeMachineSummaryMetrics(local.uiMachineSummaryMetrics),
    parse: value => Array.isArray(value) ? { success: true, value: normalizeMachineSummaryMetrics(value) } : { success: false },
    commit: (_local, value, writeLocal) => {
        if (Array.isArray(value)) writeLocal({ uiMachineSummaryMetrics: [...normalizeMachineSummaryMetrics(value)] });
    },
};
