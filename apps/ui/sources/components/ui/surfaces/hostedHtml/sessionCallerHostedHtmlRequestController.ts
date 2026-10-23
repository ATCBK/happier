import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { buildQualifiedPluginContributionKey, PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import {
    PluginUiExecuteActionRequestV1Schema,
    PluginUiResourceSubscriptionRequestV1Schema,
    type PluginUiJsonValueV1,
    type PluginUiResourceSubscriptionEventV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    createPluginUiProjectedActionResolver,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import type { CallerHostedHtmlHostApiRequestHandler } from '@/components/plugins/hostApi/hostedWebAdapter';
import {
    dispatchPluginSurfaceAction,
    type PluginSurfaceHostActionExecute,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import {
    createPluginSurfaceResourceReadHandler,
    type PluginSurfaceResourceReadTransport,
    type PluginSurfaceResourceBinding,
} from '@/components/plugins/surfaces/pluginSurfaceResourceRead';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import type { PluginUiLaunchInputV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginResourceContextV1 } from '@happier-dev/protocol';
import {
    createPluginSurfaceResourceWatchHandlers,
    type PluginSurfaceResourceWatchTransport,
} from '@/components/plugins/surfaces/pluginSurfaceResourceWatch';

export type CurrentCallerHostedHtmlPluginTarget = Readonly<{
    machineId: string | null;
    serverId: string | null;
    projection: PluginUiProjectionModel;
    isCurrent: () => boolean;
}>;

export type SessionCallerHostedHtmlRequestController = Readonly<{
    handleRequest: CallerHostedHtmlHostApiRequestHandler;
    dispose(): void;
}>;

type ResourceHandlers = ReturnType<typeof createPluginSurfaceResourceWatchHandlers>;

function isJsonRecord(
    value: PluginUiJsonValueV1 | undefined,
): value is Readonly<Record<string, PluginUiJsonValueV1>> {
    return value !== null
        && value !== undefined
        && typeof value === 'object'
        && !Array.isArray(value);
}

function readJsonRecord(
    value: PluginUiJsonValueV1 | undefined,
): Readonly<Record<string, PluginUiJsonValueV1>> | null {
    return isJsonRecord(value) ? value : null;
}

function readExactQualifiedReference(value: unknown): Readonly<{ pluginId: string; localId: string }> | null {
    const parsed = PluginContributionIdentityV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** The viewer's exact current declaration selects the Resource's origin and context. */
export function resolveCallerHostedHtmlResourceBindingV1(input: Readonly<{
    target: CurrentCallerHostedHtmlPluginTarget;
    reference: Readonly<{ pluginId: string; localId: string }>;
    serverId: string;
    sessionId?: string;
    mountInstanceKey?: string;
    launchInput?: PluginUiLaunchInputV1;
}>): Readonly<{ machineId: string; serverId: string; expectedCallerOccurrenceId: string; context: PluginResourceContextV1 }> | null {
    const { target, reference } = input;
    if (!target.isCurrent()) return null;
    const declarations = Object.values(target.projection.resourcesById).filter(row => row.pluginId === reference.pluginId && row.id === reference.localId);
    const declaration = declarations.length === 1 ? declarations[0] : null;
    const plugin = target.projection.installedPackagesById[reference.pluginId];
    if (!declaration || declaration.pluginId !== reference.pluginId || declaration.id !== reference.localId
        || !plugin?.enabled || !plugin.occurrenceId
        || declaration.occurrenceId !== undefined && declaration.occurrenceId !== plugin.occurrenceId) return null;
    const origin = readPluginUiContributionOrigin(declaration);
    const packageOrigin = readPluginUiContributionOrigin(plugin);
    const machineId = target.machineId ?? origin?.machineId;
    const serverId = target.serverId ?? origin?.serverId;
    if (!machineId || serverId !== input.serverId
        || origin && (origin.phase !== 'current' || !origin.interactionEnabled || origin.machineId !== machineId || origin.serverId !== serverId)
        || packageOrigin && (packageOrigin.machineId !== machineId || packageOrigin.serverId !== serverId)) return null;
    const context = declaration.scope === 'global' ? { kind: 'global' as const }
        : declaration.scope === 'session' && input.sessionId ? { kind: 'session' as const, sessionId: input.sessionId }
        : declaration.scope === 'surface' && input.mountInstanceKey ? { kind: 'surface' as const, mountInstanceKey: input.mountInstanceKey,
            launchInput: input.launchInput ?? {} } : null;
    return context ? { machineId, serverId, expectedCallerOccurrenceId: plugin.occurrenceId, context } : null;
}

/**
 * Host-private request adapter for a caller-authored document or saved widget.
 *
 * It deliberately creates no plugin caller. Qualified contributed Actions and
 * Resources resolve against the incumbent current daemon projection, then use
 * the same Action/Resource dispatchers as installed surfaces. The Resource RPC
 * still names the target plugin as `callerPluginId` because that legacy field
 * selects the target plugin service; it is never projected into guest context
 * or used as caller provenance. Bare ActionSpec invocations are host-stamped as
 * Account automation: executable document code is not a present-user caller,
 * even when its frame is visible on the UI surface.
 */
export function createSessionCallerHostedHtmlRequestController(input: Readonly<{
    sessionId?: string;
    serverId: string;
    serverIdentityId: string;
    accountId: string;
    executeHostAction: PluginSurfaceHostActionExecute;
    isAccountCurrent: () => boolean;
    /** Current exact-Home Session read authority supplied by the canonical Session projection. */
    isSessionCurrent?: () => boolean;
    pluginTarget: CurrentCallerHostedHtmlPluginTarget | null;
    mountInstanceKey?: string;
    launchInput?: PluginUiLaunchInputV1;
    publishResourceEvent: (event: PluginUiResourceSubscriptionEventV1) => void;
    notify: (input: Readonly<{ requestId: string; message: string; severity: 'info' | 'warning' | 'error' }>) => void;
    dispatchAction?: typeof dispatchPluginSurfaceAction;
    readResource?: PluginSurfaceResourceReadTransport;
    watchResource?: Partial<PluginSurfaceResourceWatchTransport>;
}>): SessionCallerHostedHtmlRequestController {
    let disposed = false;
    const watchHandlersByResourceKey = new Map<string, ResourceHandlers>();
    const subscriptionResourceKeys = new Map<string, string>();
    const isCurrent = (): boolean => !disposed && input.isAccountCurrent()
        && (input.sessionId === undefined || input.isSessionCurrent?.() === true);
    const readPluginTarget = (): CurrentCallerHostedHtmlPluginTarget => {
        const target = input.pluginTarget;
        if (!target || !isCurrent() || !target.isCurrent()) {
            throw new Error('caller_surface_retired');
        }
        return target;
    };
    const watchHandlers = (key: string, pluginId: string, target: CurrentCallerHostedHtmlPluginTarget, binding: PluginSurfaceResourceBinding): ResourceHandlers => {
        const existing = watchHandlersByResourceKey.get(key);
        if (existing) return existing;
        const created = createPluginSurfaceResourceWatchHandlers({
            pluginId,
            resource: binding,
            deliver: input.publishResourceEvent,
            isCurrent: () => isCurrent() && target.isCurrent(),
            ...(input.watchResource === undefined ? {} : { transport: input.watchResource }),
        });
        watchHandlersByResourceKey.set(key, created);
        return created;
    };

    const handleRequest: CallerHostedHtmlHostApiRequestHandler = async (request, options) => {
        if (!isCurrent()) throw new Error('caller_surface_retired');
        if (request.method === 'executeAction') {
            const parsed = PluginUiExecuteActionRequestV1Schema.safeParse(request.payload);
            if (!parsed.success) throw new Error('caller_surface_action_invalid');
            const actionInput = parsed.data.input;
            const actionInputRecord = readJsonRecord(actionInput);
            if (input.sessionId !== undefined && actionInputRecord
                && Object.prototype.hasOwnProperty.call(actionInputRecord, 'sessionId')
                && actionInputRecord.sessionId !== input.sessionId) {
                throw new Error('caller_surface_session_mismatch');
            }
            if (typeof parsed.data.action === 'string') {
                const actionId = ActionIdSchema.safeParse(parsed.data.action);
                if (!actionId.success) throw new Error('caller_surface_action_invalid');
                if (
                    actionId.data === 'session.message.send'
                    && options?.consumeHostTransientActivation?.() !== true
                ) {
                    throw new Error('caller_surface_transient_activation_required');
                }
                const result = await input.executeHostAction(actionId.data, parsed.data.input, {
                    serverId: input.serverId,
                    serverIdentityId: input.serverIdentityId,
                    runtimeAccountId: input.accountId,
                    ...(input.sessionId ? { defaultSessionId: input.sessionId } : {}),
                    actionRequestId: request.requestId,
                    surface: 'ui',
                    // Caller-authored HTML is executable automation, not a
                    // host-observed present-user gesture. Stamp this at the
                    // bridge so the shared Action policy keeps its dangerous
                    // default confirmation floor; the document cannot supply
                    // authority or any approval bypass through Action input.
                    authority: 'account_automation',
                    ...(options?.signal ? { signal: options.signal } : {}),
                });
                if (!result.ok) throw new Error(result.errorCode);
                return result.result as PluginUiJsonValueV1;
            }
            const target = readPluginTarget();
            const action = target.projection.actionsById[buildQualifiedPluginContributionKey(parsed.data.action)];
            const origin = readPluginUiContributionOrigin(action);
            const machineId = target.machineId ?? origin?.machineId;
            const serverId = target.serverId ?? origin?.serverId;
            if (!machineId || serverId !== input.serverId || origin && (origin.phase !== 'current' || !origin.interactionEnabled
                || origin.machineId !== machineId || origin.serverId !== serverId)) throw new Error('caller_surface_retired');
            const outcome = await (input.dispatchAction ?? dispatchPluginSurfaceAction)({
                action: parsed.data.action,
                ...(parsed.data.input === undefined ? {} : { input: parsed.data.input }),
                resolveContributedAction: createPluginUiProjectedActionResolver(target.projection.actionsById),
                contributedAction: {
                    machineId,
                    serverId,
                    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                },
                ...(input.sessionId ? { clientAction: { sessionId: input.sessionId } } : {}),
                invocationSurface: 'ui',
                isContributedActionAvailable: target.isCurrent,
                isCurrent: () => isCurrent() && target.isCurrent(),
                ...(options?.signal ? { signal: options.signal } : {}),
            });
            if (!outcome.ok) throw new Error(outcome.reason);
            return outcome.result;
        }
        if (request.method === 'readResource' || request.method === 'watchResource') {
            const payload = request.payload;
            const record = readJsonRecord(payload);
            const reference = readExactQualifiedReference(record?.resource);
            if (!reference) throw new Error('caller_surface_resource_invalid');
            const target = readPluginTarget();
            const binding = resolveCallerHostedHtmlResourceBindingV1({ target, reference, serverId: input.serverId,
                sessionId: input.sessionId, mountInstanceKey: input.mountInstanceKey, launchInput: input.launchInput });
            if (!binding) throw new Error('plugin_resource_not_found');
            if (request.method === 'readResource') {
                const handler = createPluginSurfaceResourceReadHandler({
                    pluginId: reference.pluginId,
                    resource: {
                        ...binding,
                        ...(input.readResource === undefined ? {} : { read: input.readResource }),
                    },
                    isCurrent: () => isCurrent() && target.isCurrent(),
                });
                return await handler(request, options);
            }
            const parsedWatch = PluginUiResourceSubscriptionRequestV1Schema.safeParse(record);
            if (!parsedWatch.success) throw new Error('caller_surface_resource_invalid');
            const key = buildQualifiedPluginContributionKey(reference);
            const previousKey = subscriptionResourceKeys.get(parsedWatch.data.subscriptionId);
            if (previousKey && previousKey !== key) {
                // Re-establishing one guest id retires its previous contextual
                // owner before opening a Resource with a different scope.
                await watchHandlersByResourceKey.get(previousKey)!.disposeHostResource({
                    ...request, payload: { subscriptionId: parsedWatch.data.subscriptionId },
                });
            }
            const result = await watchHandlers(key, reference.pluginId, target, binding).watchResource(request, options);
            subscriptionResourceKeys.set(parsedWatch.data.subscriptionId, key);
            return result;
        }
        if (request.method === 'disposeHostResource') {
            const payload = request.payload;
            const record = readJsonRecord(payload);
            const subscriptionId = typeof record?.subscriptionId === 'string'
                ? record.subscriptionId
                : null;
            if (subscriptionId === null) throw new Error('caller_surface_resource_invalid');
            const resourceKey = subscriptionResourceKeys.get(subscriptionId);
            if (!resourceKey) throw new Error('caller_surface_resource_invalid');
            subscriptionResourceKeys.delete(subscriptionId);
            return await watchHandlersByResourceKey.get(resourceKey)!.disposeHostResource(request);
        }
        if (request.method === 'notify') {
            const payload = request.payload;
            const record = readJsonRecord(payload);
            const message = typeof record?.message === 'string' ? record.message.trim() : '';
            if (!message) throw new Error('caller_surface_notify_invalid');
            input.notify({
                requestId: request.requestId,
                message,
                severity: record?.severity === 'warning' || record?.severity === 'error'
                    ? record.severity
                    : 'info',
            });
            return null;
        }
        throw new Error('caller_surface_method_unavailable');
    };

    return Object.freeze({
        handleRequest,
        dispose(): void {
            if (disposed) return;
            disposed = true;
            for (const handlers of watchHandlersByResourceKey.values()) handlers.dispose();
            watchHandlersByResourceKey.clear();
            subscriptionResourceKeys.clear();
        },
    });
}
