import type { CurrentUiContextSnapshotV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiResolvedSemanticCommandV1 } from '@happier-dev/protocol/plugins/ui';
import { getPluginMachineExecutionOriginRef } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';

import {
    createPluginUiProjectedActionResolver,
    isPluginProjectedActionExecutable,
    type PluginUiActionProjection,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import {
    PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY,
    readPluginUiContributionOrigin,
} from '@/sync/domains/plugins/ui/projectionUnion';
import { launchPluginSurfaceAction } from './launchPluginSurfaceAction';
import type { PluginSurfaceScopedLaunchFacts } from './pluginSurfaceLaunchAuthority';
import type {
    PluginSurfaceActionDispatchOutcome,
    PluginSurfaceContributedActionTransport,
} from './pluginSurfaceActionDispatch';
import type {
    PluginSurfaceOpenHandler,
    PluginSurfaceOpenOutcome,
} from './openPluginSurface';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

/**
 * The one host router from an already-resolved plugin semantic command to its
 * canonical owner.
 *
 * Every declarative family whose descriptor carries `executeAction |
 * openSurface` — Session header actions today, Universal Search provider rows
 * now — routes through here. Each family still owns which contribution the
 * reader picked and which host facts scope it; none of them owns *how* a
 * command executes. Before this module there was one such router living inside
 * the Session-header adapter, and a second family would have had to copy its
 * daemon/client target branch, its generation check and its current-intent
 * handler — three places for one decision.
 *
 * It adds no authority: `launchPluginSurfaceAction` remains the §3.5 dispatcher
 * that owns identity qualification, the `executionSurface: 'ui'` stamp,
 * AbortSignal/RPC cancellation and the typed failure vocabulary, and the
 * caller-supplied `openSurface` remains the destination owner.
 */

/**
 * Semantic commands are not a second scope resolver. The registered scope
 * already owns whether its retained projection is current and exactly which
 * machine/server admitted it. A retained descriptor stays
 * displayable, but it is not interaction authority once that owner revokes it.
 */
export function resolveCurrentPluginSemanticCommandScope(
    _projection: PluginUiProjectionModel,
    scopedLaunchFacts: PluginSurfaceScopedLaunchFacts | null | undefined,
): PluginSurfaceScopedLaunchFacts | null {
    if (
        !scopedLaunchFacts
        || scopedLaunchFacts.interactionEnabled !== true
        || !scopedLaunchFacts.machineId
        || scopedLaunchFacts.machineId.trim().length === 0
    ) {
        return null;
    }
    return scopedLaunchFacts;
}

/** Client-target Actions retain the projection's currentness without a daemon address. */
export function isCurrentPluginSemanticCommandProjection(
    _projection: PluginUiProjectionModel,
    scopedLaunchFacts: PluginSurfaceScopedLaunchFacts | null | undefined,
): boolean {
    return scopedLaunchFacts?.interactionEnabled === true;
}

function hasContributionOriginField(entry: unknown): boolean {
    return entry !== null
        && typeof entry === 'object'
        && Object.prototype.hasOwnProperty.call(entry, PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY);
}

function resolveProjectedActionExecutionScope(
    projection: PluginUiProjectionModel,
    projectedAction: PluginUiActionProjection,
    scopedLaunchFacts: PluginSurfaceScopedLaunchFacts | null | undefined,
): PluginSurfaceScopedLaunchFacts | null {
    if (!hasContributionOriginField(projectedAction)) {
        return resolveCurrentPluginSemanticCommandScope(projection, scopedLaunchFacts);
    }
    if (!isCurrentPluginSemanticCommandProjection(projection, scopedLaunchFacts)) return null;
    const origin = readPluginUiContributionOrigin(projectedAction);
    const executionOrigin = origin?.executionOrigin ?? null;
    const executionRef = executionOrigin ? getPluginMachineExecutionOriginRef(executionOrigin) : null;
    if (
        !origin
        || origin.phase !== 'current'
        || origin.interactionEnabled !== true
        || (
            executionRef !== null
            && (
                executionRef.pluginId !== projectedAction.pluginId
                || executionRef.machineId !== origin.machineId
            )
        )
    ) return null;
    return Object.freeze({
        serverId: origin.serverId,
        machineId: origin.machineId,
        interactionEnabled: true,
    });
}

export type DispatchPluginResolvedSemanticCommandInput = Readonly<{
    projection: PluginUiProjectionModel;
    /** The plugin whose contribution the reader activated. */
    callerPluginId: string;
    command: PluginUiResolvedSemanticCommandV1;
    scopedLaunchFacts?: PluginSurfaceScopedLaunchFacts | null;
    /** Existing Account-lifetime predicate; never reconstructed by this router. */
    scopeIsCurrent?: (() => boolean) | null;
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    sessionId?: string | null;
    execute?: PluginSurfaceContributedActionTransport;
    openSurface?: PluginSurfaceOpenHandler;
    readCurrentUiContext?: () => CurrentUiContextSnapshotV1 | null | undefined;
    /**
     * Forwarded to the canonical dispatcher, which refuses an already-aborted
     * invocation and carries the signal into machine-RPC cancellation.
     */
    signal?: AbortSignal;
}>;

export async function dispatchPluginResolvedSemanticCommand(
    input: DispatchPluginResolvedSemanticCommandInput,
): Promise<PluginSurfaceActionDispatchOutcome | PluginSurfaceOpenOutcome> {
    const { projection, command } = input;
    if (command.kind === 'openSurface') {
        if (
            !isCurrentPluginSemanticCommandProjection(projection, input.scopedLaunchFacts)
            || input.scopeIsCurrent?.() === false
        ) {
            return { ok: false, code: 'stale_surface', reason: 'plugin_ui_generation_retired' };
        }
        if (!input.openSurface) {
            return { ok: false, code: 'unavailable', reason: 'plugin_ui_surface_open_unavailable' };
        }
        return await input.openSurface({
            destination: command.destination,
            ...(command.input === undefined ? {} : { input: command.input }),
            ...(command.subPath === undefined ? {} : { subPath: command.subPath }),
            ...(command.instanceKey === undefined ? {} : { instanceKey: command.instanceKey }),
        });
    }

    const resolveContributedAction = createPluginUiProjectedActionResolver(projection.actionsById);
    const projectedAction = resolveContributedAction(command.action);
    if (!isPluginProjectedActionExecutable(projectedAction)) {
        return { ok: false, code: 'unavailable', reason: 'plugin_ui_action_unavailable' };
    }
    const scopedAuthority = resolveProjectedActionExecutionScope(
        projection,
        projectedAction,
        input.scopedLaunchFacts,
    );
    const scopedMachineId = scopedAuthority?.machineId;
    if (
        projectedAction.execution.target === 'daemon'
        && (!scopedAuthority || !scopedMachineId)
    ) {
        return { ok: false, code: 'unavailable', reason: 'plugin_ui_action_unavailable' };
    }
    const launched = await launchPluginSurfaceAction({
        callerPluginId: input.callerPluginId,
        // Structured, never the qualified string: a bare string would be offered
        // to the dispatcher's host ActionSpec branch first, so a plugin whose
        // local action id matched a `surfaces.plugin` ActionSpec id could be
        // routed to the wrong executor.
        action: command.action,
        ...(command.input === undefined ? {} : { input: command.input }),
        resolveContributedAction,
        pluginUiProjection: projection,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(projectedAction.execution.target === 'daemon'
            ? {
                contributedAction: {
                    machineId: scopedMachineId!,
                    serverId: scopedAuthority!.serverId,
                    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                    ...(input.execute ? { execute: input.execute } : {}),
                },
            }
            : {}),
        ...(projectedAction.execution.target !== 'daemon'
            ? {
                clientAction: {
                    ...(input.execute ? { execute: input.execute } : {}),
                    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                    ...(input.openSurface ? { openSurface: input.openSurface } : {}),
                    ...(input.readCurrentUiContext
                        ? { currentUiContext: input.readCurrentUiContext }
                        : {}),
                },
            }
            : {}),
        ...(input.scopeIsCurrent ? { isCurrent: input.scopeIsCurrent } : {}),
    });
    return launched.outcome;
}
