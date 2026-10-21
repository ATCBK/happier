import * as React from 'react';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { WidgetBindingResolutionInputV1 } from '@happier-dev/protocol/widgets';
import { useCorePageWidgetAreaBinding } from '@/components/widgets/area/useCorePageWidgetAreaBinding';
import type { UsagePeriod } from '@/sync/api/account/usagePeriods';
import { createUsageWidgetPresets, type UsageWidgetPresetId } from './usageWidgetPresets';
import { usageWidgetSurfaceContext } from './usageWidgetPageContext';

/** Thin host composition; named views, revisions, Reset/Undo and Artifact custody remain platform-owned. */
export function useUsageWidgetAreaBinding(input: Readonly<{
    serverId: string;
    providedContext: WidgetBindingResolutionInputV1['context'];
    /** Only the admitted Session route declares a Session editor slot. */
    sessionId?: string;
    /** The page's period by name; the provided context carries only its resolved start. */
    period: UsagePeriod;
    names: Readonly<Record<UsageWidgetPresetId, string>>;
    initialMetric?: UsageQuery['metric'];
    initialLayoutId?: string | null;
    onLayoutChange?: (layoutId: string) => void;
}>): { -readonly [K in keyof ReturnType<typeof useCorePageWidgetAreaBinding>]: ReturnType<typeof useCorePageWidgetAreaBinding>[K] } & {
    presets: ReturnType<typeof createUsageWidgetPresets>;
} {
    const presets = React.useMemo(() => createUsageWidgetPresets(input.names, { initialMetric: input.initialMetric }), [input.names, input.initialMetric]);
    const context = React.useMemo(() => usageWidgetSurfaceContext(input.providedContext, input.period, input.sessionId), [input.providedContext, input.period, input.sessionId]);
    const binding = useCorePageWidgetAreaBinding({ serverId: input.serverId, pageId: 'usage', area: 'main', presets, context, initialLayoutId: input.initialLayoutId, onSelectLayout: input.onLayoutChange });
    return React.useMemo(() => ({ ...binding, presets }), [binding, presets]);
}
