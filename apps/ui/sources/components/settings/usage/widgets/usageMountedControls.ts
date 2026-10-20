import * as React from 'react';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { t } from '@/text';

/** Publish the mounted disclosure's existing callback; no persisted presentation or second writer. */
export function useUsageDisclosureCommand(title: string, expanded: boolean, onToggle: () => void, enabled = true): void {
    useCurrentUiContextLocalCommands(enabled ? [{ key: 'toggle',
        title: `${title}: ${t(expanded ? 'usage.showLess' : 'usage.showAll')}`, invoke: onToggle }] : []);
}

/** The public chart owns exact-value rendering; this mounted host owns its local presentation intent. */
export function useUsageChartDetails(title: string, enabled: boolean): Readonly<{
    valuesExpanded: boolean;
    onValuesExpandedChange(expanded: boolean): void;
}> {
    const [valuesExpanded, onValuesExpandedChange] = React.useState(false);
    useUsageDisclosureCommand(`${title}: ${t('common.details')}`, valuesExpanded,
        () => onValuesExpandedChange(!valuesExpanded), enabled);
    return { valuesExpanded, onValuesExpandedChange };
}
