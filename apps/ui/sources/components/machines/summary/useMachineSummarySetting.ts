import * as React from 'react';

import { useLocalSetting } from '@/sync/domains/state/storage';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    normalizeMachineSummaryMetrics,
    type MachineSummaryMetric,
    type MachineSummaryStyle,
} from './machineSummaryStripModel';

/**
 * The Machine summary setting on this device (R8, MPG-21): the style and the shown metrics, read and
 * written through the same normalizer `settings.set` uses. Any metric toggles, including the last.
 */
export function useMachineSummarySettingValue() {
    const style = useLocalSetting('uiMachineSummaryStyle');
    const stored = useLocalSetting('uiMachineSummaryMetrics');
    const metrics = React.useMemo(() => normalizeMachineSummaryMetrics(stored), [stored]);
    return { style, metrics };
}

export function useMachineSummarySetting(): Readonly<{
    style: MachineSummaryStyle;
    metrics: readonly MachineSummaryMetric[];
    setStyle(next: MachineSummaryStyle): void;
    toggleMetric(metric: MachineSummaryMetric): void;
}> {
    const { style, metrics } = useMachineSummarySettingValue();
    const { setSetting } = useSettingActionFeedback();
    const setStyle = React.useCallback((next: MachineSummaryStyle) => {
        fireAndForget(setSetting({ anchor: 'appearance.machineSummaryStyle' }, next));
    }, [setSetting]);
    const toggleMetric = React.useCallback((metric: MachineSummaryMetric) => {
        const next = metrics.includes(metric) ? metrics.filter(candidate => candidate !== metric) : [...metrics, metric];
        fireAndForget(setSetting({ anchor: 'appearance.machineSummaryMetrics' }, [...normalizeMachineSummaryMetrics(next)]));
    }, [metrics, setSetting]);
    return { style, metrics, setStyle, toggleMetric };
}
