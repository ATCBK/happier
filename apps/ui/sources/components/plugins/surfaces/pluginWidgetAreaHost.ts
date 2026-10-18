import { createPluginWidgetAreaHostPortV1, PluginUiWidgetAreaResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { PluginUiWidgetAreaDeclarationsV1Schema } from '@happier-dev/protocol/plugins/contributions/ui';
import type { BoundPluginSurfaceFacts } from './boundPluginSurfaceController';
import { dispatchPluginSurfaceAction, type PluginSurfaceHostActionBinding, type PluginSurfaceActionMountedBinding } from './pluginSurfaceActionDispatch';
import type { PluginSurfaceHostApiMethodHandler } from './createPluginSurfaceHostApi';
import { PluginUiJsonValueV1Schema } from '@happier-dev/protocol/plugins/ui';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

/** Admission comes from this exact normalized destination row, never a physical host name. */
export function createPluginWidgetAreaHostHandler(input: Readonly<{
    facts: BoundPluginSurfaceFacts; isCurrent(): boolean; lifetimeSignal: AbortSignal;
    hostAction: PluginSurfaceHostActionBinding; callerBinding: PluginSurfaceActionMountedBinding | null;
    /** Host-private presentation path; never decoded from a plugin request. */
    hostControl?: true;
    /** The same mounted-host readiness decision used by ordinary Host API failures. */
    isConnectionPending?: (reason: string) => boolean;
    /** The mount's own words for a Machine-owned refusal (names the Run-on Machine); the code stays the code. */
    describeUnavailable?: (reason: string) => string | undefined;
}>): PluginSurfaceHostApiMethodHandler | null {
    const { facts } = input;
    const scope = facts.accountLifetime?.scope;
    if (!scope || facts.serverId && scope.serverId !== facts.serverId) return null;
    // The admitted page declaration owns its areas. Its supplying occurrence
    // need not be the selected execution Machine's occurrence (or have one).
    // Plugin-code operations retain the mounted-caller gate below. Host controls
    // use this same declared-area admission with their private mount lifetime.
    const matches = Object.values(facts.pluginUiProjection?.surfacePlacementsById ?? {}).filter(row => row.pluginId === facts.pluginId
        && row.descriptorId === facts.contributionId
        && row.binding.kind === 'destination' && row.binding.container === 'appPage');
    if (matches.length !== 1) return null;
    const declarations = PluginUiWidgetAreaDeclarationsV1Schema.safeParse(matches[0]!.widgetAreas);
    if (!declarations.success || !declarations.data.length) return null;
    const port = createPluginWidgetAreaHostPortV1({ scope, pluginId: facts.pluginId, pageId: facts.contributionId,
            declarations: declarations.data, isCurrent: input.isCurrent,
            execute: async (actionId, actionInput, context) => {
                const outcome = input.hostControl
                    ? await input.hostAction.execute(actionId, actionInput, { ...input.hostAction.context, ...context,
                        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }).then(result => result.ok
                            ? { ok: true as const, result: PluginUiJsonValueV1Schema.parse(result.result) }
                            : { ok: false as const, code: 'unavailable' as const, reason: result.errorCode, message: result.error })
                    : await dispatchPluginSurfaceAction({ action: actionId, input: PluginUiJsonValueV1Schema.parse(actionInput),
                    ...(context.actionRequestId ? { actionRequestId: context.actionRequestId } : {}), callerPluginId: facts.pluginId, callerContributionLocalId: facts.contributionId,
                    ...(input.callerBinding ? { callerBinding: input.callerBinding } : {}),
                    hostAction: { ...input.hostAction, context: { ...input.hostAction.context, ...context } },
                    isCurrent: input.isCurrent, ...(context.signal ? { signal: context.signal } : {}) });
                if (outcome.ok) return { ok: true, result: outcome.result };
                // Area results are nested payloads, so the generic Host API error enricher does
                // not see their refusals. Preserve its pending fact without admitting the Action.
                if (outcome.code === 'unavailable' && input.isConnectionPending?.(outcome.reason)) {
                    return { ok: false, errorCode: 'plugin_surface_connection_pending', error: 'plugin_surface_connection_pending' };
                }
                const error = outcome.message
                    ?? (outcome.code === 'unavailable' ? input.describeUnavailable?.(outcome.reason) : undefined)
                    ?? outcome.reason;
                return { ok: false, errorCode: outcome.reason, error };
            },
    });
    return async (request, options) => {
        const lifetime = mergeAbortSignals([input.lifetimeSignal, options?.signal]);
        try {
            return PluginUiJsonValueV1Schema.parse(PluginUiWidgetAreaResultV1Schema.parse(await port.execute(request.payload, lifetime.signal, request.requestId)));
        } finally { lifetime.dispose(); }
    };
}
