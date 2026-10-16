import * as React from 'react';
import type { ActionExecuteResult, ActionId } from '@happier-dev/protocol';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { buildWidgetAreaActionInputV1, PluginUiWidgetAreaResultV1Schema, pluginUiWidgetAreaOperationHasOutwardEffectV1 } from '@happier-dev/protocol/plugins/ui';
import { WidgetSurfaceRefV1Schema, WidgetSurfaceReadV1Schema, readWidgetActionSurfaceV1, type WidgetAreaPresetV1, type WidgetAreaPresetUndoV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { widgetProvidedContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import type { WidgetAreaPort } from './useWidgetAreaLayout';
import { registerWidgetAreaLayoutSelectionOwner, widgetAreaLayoutBaseSurface, type WidgetAreaLayoutSelectionOwner } from './widgetAreaLayoutSelection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/** A core page supplies defaults and context, while the existing Account area owner keeps its edits. */
export function useCorePageWidgetAreaBinding(input: Readonly<{
    serverId: string; pageId: string; area: string; preset?: WidgetAreaPresetV1; presets?: readonly WidgetAreaPresetV1[]; context: WidgetSurfaceContext;
    /** Route intent is admitted before the first read, never applied as a later visual selection. */
    initialLayoutId?: string | null;
    /** A route may record the acknowledged selection; it is not another selected-layout owner. */
    onSelectLayout?: (layoutId: string) => void;
}>): Readonly<{
    surface: WidgetSurfaceRefV1 | null; port: WidgetAreaPort | null; context: WidgetSurfaceContext;
    resetPreset(target?: WidgetSurfaceRefV1): Promise<ActionExecuteResult>;
    undoReset(capture: WidgetAreaPresetUndoV1): Promise<ActionExecuteResult>;
    listLayouts(): Promise<ActionExecuteResult>;
    createLayout(layoutId: string, name: string): Promise<ActionExecuteResult>;
    selectLayout(layoutId: string): Promise<ActionExecuteResult>;
    executeLayoutAction(actionId: Extract<ActionId, `widgets.area.layout.${string}`>, args: unknown): Promise<ActionExecuteResult>;
}> {
    const lifetime = useActiveServerAccountScopeLifetime();
    const viewer = lifetime?.scope ?? null;
    const [selected, setSelected] = React.useState<Readonly<{ serverId: string; accountId: string; pageId: string; area: string; layoutId?: string; routeLayoutId?: string | null }> | null>(null);
    const layoutId = selected && viewer && areServerProfileIdentifiersEquivalent(selected.serverId, viewer.serverId) && selected.accountId === viewer.accountId
        && selected?.pageId === input.pageId && selected.area === input.area && selected.routeLayoutId === input.initialLayoutId
        ? selected.layoutId : input.initialLayoutId ?? input.preset?.id ?? input.presets?.[0]?.id;
    const surface = React.useMemo((): WidgetSurfaceRefV1 | null => {
        if (!lifetime?.isCurrent() || !selectActiveServerAccountScopeForServer(viewer, input.serverId)) return null;
        return WidgetSurfaceRefV1Schema.parse({ serverId: lifetime.scope.serverId, accountId: lifetime.scope.accountId,
            owner: { kind: 'corePage', pageId: input.pageId, area: input.area, ...(layoutId ? { layoutId } : {}) } });
    }, [input.area, input.pageId, layoutId, input.serverId, lifetime, viewer]);
    const bindingIdentity = React.useMemo(() => ({}), [input.context, input.onSelectLayout, input.preset, input.presets, surface]);
    const liveBinding = React.useRef(bindingIdentity);
    liveBinding.current = bindingIdentity;
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const binding = React.useMemo(() => {
        const isCurrent = () => mounted.current && liveBinding.current === bindingIdentity && lifetime?.isCurrent() === true;
        const failed = () => ({ ok: false as const, errorCode: 'widget_area_scope_retired', error: 'widget_area_scope_retired' });
        const resolvePresets = (target: WidgetSurfaceRefV1) => surface && areServerProfileIdentifiersEquivalent(target.serverId, surface.serverId) && target.accountId === surface.accountId
            && target.owner.kind === 'corePage' && target.owner.pageId === input.pageId && target.owner.area === input.area
            ? input.presets ?? (input.preset ? [input.preset] : []) : undefined;
        const execute = async (actionId: ActionId, args: unknown, signal?: AbortSignal, context = input.context) => {
            if (!surface || !lifetime || !isCurrent() || signal?.aborted) return failed();
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            if (!isCurrent() || signal?.aborted) return failed();
            const target = readWidgetActionSurfaceV1(args) ?? surface;
            return createDefaultActionExecutor({ resolveWidgetAreaPresets: resolvePresets, widgetAreaIsCurrent: isCurrent }).execute(actionId, args, {
                surface: 'ui', actionCaller: { kind: 'host' }, serverId: lifetime.scope.serverId,
                expectedAccountId: lifetime.scope.accountId, signal, widgetAreaContext: { surface: target, values: widgetProvidedContext(context) },
            });
        };
        const port: WidgetAreaPort | null = surface ? { execute: async (operation, signal, admitted) => {
            const target = admitted?.surface ?? surface;
            if (!sameStrictJsonValue(widgetAreaLayoutBaseSurface(target), widgetAreaLayoutBaseSurface(surface)))
                return { ok: false, errorCode: 'widget_area_owner_mismatch', error: 'widget_area_owner_mismatch' };
            const result = await execute(operation.actionId, buildWidgetAreaActionInputV1(operation, target), signal, admitted?.context);
            if ((!isCurrent() || signal?.aborted) && !(result.ok && pluginUiWidgetAreaOperationHasOutwardEffectV1(operation))) return failed();
            const parsed = PluginUiWidgetAreaResultV1Schema.safeParse(result);
            return parsed.success ? parsed.data : { ok: false, errorCode: 'invalid_widget_area_result', error: 'invalid_widget_area_result' };
        } } : null;
        const selectionOwner: WidgetAreaLayoutSelectionOwner | null = surface ? { surface, isCurrent,
            read: (target, signal) => {
                const defaultId = input.preset?.id ?? input.presets?.[0]?.id;
                const destination = target.owner.kind === 'corePage' && !target.owner.layoutId && defaultId
                    ? { ...target, owner: { ...target.owner, layoutId: defaultId } } : target;
                return execute('widgets.item.list', { surface: destination }, signal);
            },
            select: target => {
                if (target.owner.kind === 'corePage') setSelected({ serverId: target.serverId, accountId: target.accountId,
                    pageId: input.pageId, area: input.area, layoutId: target.owner.layoutId, routeLayoutId: input.initialLayoutId });
                if (target.owner.kind === 'corePage' && target.owner.layoutId) input.onSelectLayout?.(target.owner.layoutId);
            },
        } : null;
        return { selectionOwner, port, resetPreset: async (target = surface) => {
            const read = await execute('widgets.item.list', { surface: target });
            const parsed = read.ok ? WidgetSurfaceReadV1Schema.safeParse(read.result) : null;
            return parsed?.success ? execute('widgets.area.layout.reset', { surface: target, expectedRevision: parsed.data.revision ?? null }) : read;
        },
            listLayouts: () => execute('widgets.area.layout.list', { surface }),
            createLayout: (layoutId: string, name: string) => execute('widgets.area.layout.create', { surface, layoutId, name, fromSurface: surface }),
            selectLayout: async (layoutId: string) => {
                if (!surface || surface.owner.kind !== 'corePage') return failed();
                return execute('widgets.area.layout.select', { surface: { ...surface, owner: { ...surface.owner, layoutId } } });
            },
            executeLayoutAction: execute,
            undoReset: (capture: WidgetAreaPresetUndoV1) => execute('widgets.area.layout.undo', { capture }) };
    }, [bindingIdentity, input.area, input.context, input.initialLayoutId, input.onSelectLayout, input.pageId, input.preset, input.presets, lifetime, surface]);
    React.useEffect(() => binding.selectionOwner ? registerWidgetAreaLayoutSelectionOwner(binding.selectionOwner) : undefined, [binding.selectionOwner]);
    return React.useMemo(() => {
        const { selectionOwner: _selectionOwner, ...operations } = binding;
        return { ...operations, surface, context: input.context };
    }, [binding, input.context, surface]);
}
