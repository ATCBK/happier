import * as React from 'react';
import { observeProjectServicePlacementActualV1, type ProjectServicePlacementGetResultV1 } from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { storage } from '@/sync/domains/state/storage';
import { readCurrentProjectAccountRows } from '@/sync/store/domains/projectAccountRows';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getLocalServiceLauncherState, readLocalServiceLauncherStore, subscribeLocalServiceLauncherStore,
    type LocalServiceLauncherStoreKeyInput } from '@/sync/domains/local/services/launch/sharedStore';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readUiWorkspaceSyncChildMachineFacts } from '@/sync/ops/workspaceSyncChildMachineFacts';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { presentLocalServiceActionFailure, readLocalServiceActionFailureReason, readLocalServiceActionOutcome } from './localServiceActionOutcome';
import { applyLocalServiceLauncherSnapshot, selectLocalServiceLaunchTargets, snapshotFromLocalServiceLauncherState } from '@/sync/domains/local/services/launch';

import {
    type LocalServiceLauncherSnapshotClient,
    type LocalServiceLauncherState,
    useLocalServiceLauncherStateController,
} from '@/sync/domains/local/services/launch';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import {
    type LocalServiceInventorySnapshotClient,
    useLocalServiceInventoryStateController,
} from '@/sync/domains/local/services/inventory/useLocalServiceInventoryState';

/**
 * The two daemon feeds a Local services surface reads — the inventory (pushed by the daemon's watch)
 * and the launcher (derived from it) — kept fresh together by one freshness rule. Mount it only in an
 * open Local services surface: it starts machine reads and a daemon watch.
 */
export type LocalServiceLiveFeedsInput = Readonly<{
    machineId: string | null;
    serverId: string | null;
    sessionId?: string;
    workspaceRoot?: string | null;
    /** Accepted SOURCE ref; omitted for Session/Machine feeds that have no Project placement. */
    workspaceRefId?: string | null;
    scope: 'workspace' | 'machine';
    /** Supplied state replaces the live feed (tests, previews); `undefined` reads live. */
    inventoryState?: LocalServiceInventoryState;
    launcherState?: LocalServiceLauncherState | null;
    inventorySnapshotClient?: LocalServiceInventorySnapshotClient;
    launcherSnapshotClient?: LocalServiceLauncherSnapshotClient;
}>;

export type LocalServiceLiveFeeds = Readonly<{
    inventoryState: LocalServiceInventoryState;
    launcherState: LocalServiceLauncherState | null;
    /** Undefined when the inventory is supplied rather than live. */
    refresh: (() => Promise<void>) | undefined;
    applyLauncherSnapshot: ReturnType<typeof useLocalServiceLauncherStateController>['applySnapshot'] | undefined;
}>;

export function useLocalServiceLiveFeeds(input: LocalServiceLiveFeedsInput): LocalServiceLiveFeeds {
    const liveInventory = useLocalServiceInventoryStateController({
        machineId: input.machineId,
        serverId: input.serverId,
        sessionId: input.sessionId,
        enabled: input.inventoryState === undefined,
        snapshotClient: input.inventorySnapshotClient,
    });
    const liveLauncher = useLocalServiceLauncherStateController({
        machineId: input.machineId,
        serverId: input.serverId,
        sessionId: input.sessionId,
        scope: input.scope,
        workspaceRoot: input.workspaceRoot ?? null,
        enabled: input.launcherState === undefined,
        snapshotClient: input.launcherSnapshotClient,
        inventorySnapshotClient: input.inventorySnapshotClient,
    });
    // Launcher freshness is owned by its shared store for every consumer and mutation surface.
    const inventorySupplied = input.inventoryState !== undefined;

    const inventoryState = input.inventoryState ?? liveInventory.state;
    const sourceLauncherState = input.launcherState !== undefined ? input.launcherState : liveLauncher.state;
    const bindings = useProjectServiceBindings(input, sourceLauncherState);
    const launcherState = bindings.state;
    const applyLauncherSnapshot = input.launcherState === undefined ? liveLauncher.applySnapshot : undefined;
    const refresh = React.useMemo(() => inventorySupplied || !liveInventory.refresh || !input.machineId || !input.serverId
        ? undefined : async () => {
            if (!bindings.binding?.isCurrent()) return;
            const refreshed = await refreshLocalServiceMachine({ machineId: input.machineId!, serverId: input.serverId!, sessionId: input.sessionId,
                accountId: bindings.binding.accountId, isCurrent: bindings.binding.isCurrent });
            await bindings.refresh(input.machineId!, refreshed);
        }, [inventorySupplied, liveInventory.refresh, input.machineId, input.serverId, input.sessionId, bindings.binding, bindings.refresh]);
    return React.useMemo(() => ({
        inventoryState,
        launcherState,
        refresh,
        applyLauncherSnapshot,
    }), [applyLauncherSnapshot, bindings.refresh, inventoryState, launcherState, refresh]);
}

/** User Refresh uses the Action owner; successful inventory publication drives
 * observation. Launcher invalidation below is only its derived read. */
async function refreshLocalServiceMachine(input: Readonly<{ serverId: string; machineId: string; sessionId?: string | null; accountId: string; isCurrent(): boolean }>) {
    try {
        const result = await createFrontDoorRuntimeActionExecutor()({ actionId: 'localServices.inventory.refresh',
            input: { machineId: input.machineId, ...(input.sessionId ? { sessionId: input.sessionId } : {}) },
            context: { surface: 'ui', serverId: input.serverId, ...(input.accountId ? { expectedAccountId: input.accountId } : {}) } });
        if (!input.isCurrent()) return false;
        const outcome = readLocalServiceActionOutcome(result);
        if (outcome.kind === 'succeeded') return true;
        if (outcome.kind === 'failed') presentLocalServiceActionFailure({ title: t('common.refresh'), reasonCode: outcome.reasonCode });
    } catch (error) {
        if (input.isCurrent()) presentLocalServiceActionFailure({ title: t('common.refresh'), reasonCode: readLocalServiceActionFailureReason(error) });
    }
    return false;
}

type ServiceActual = Extract<ProjectServicePlacementGetResultV1, { status: 'ready' }>['actual'];

/** Projection only: reads the same launcher store and parked inventory watches as the SOURCE feed.
 * The protocol observation owner selects accepted endpoints and proves native provenance. */
function useProjectServiceBindings(input: LocalServiceLiveFeedsInput, sourceState: LocalServiceLauncherState | null) {
    const enabled = input.launcherState === undefined && input.scope === 'workspace' && Boolean(input.workspaceRefId && input.serverId);
    const { binding } = useServerCredentialAccountScopeBinding(input.serverId ?? '');
    const rows = storage(state => enabled ? readCurrentProjectAccountRows(state) : null);
    const canObserve = enabled && binding?.isCurrent() === true && rows?.status === 'ready' && rows.coverage === 'complete'
        && rows.scope.accountId === binding.accountId && areServerProfileIdentifiersEquivalent(rows.scope.serverId, input.serverId ?? '');
    const sourceTargets = React.useMemo(() => sourceState ? selectLocalServiceLaunchTargets(sourceState) : [], [sourceState?.targetsById]);
    const declarations = React.useMemo(() => sourceTargets.filter(target => target.declaration && target.declaration.workspaceRefId === input.workspaceRefId
        && target.declaration.selection.kind === 'manifest'), [input.workspaceRefId, sourceTargets]);
    const [change, observeAgain] = React.useReducer((value: number) => value + 1, 0);
    const subscriptions = React.useMemo(() => new Map<string, Readonly<{ key: LocalServiceLauncherStoreKeyInput; dispose: () => void }>>(),
        [binding, enabled, input.serverId, input.workspaceRefId, input.launcherSnapshotClient, input.inventorySnapshotClient, rows]);
    React.useEffect(() => () => { for (const subscription of subscriptions.values()) subscription.dispose(); subscriptions.clear(); }, [subscriptions]);
    const [observation, setObservation] = React.useState<Readonly<{ subscriptions: typeof subscriptions; declarations: typeof declarations; values: ReadonlyMap<string, ServiceActual> }> | null>(null);
    React.useEffect(() => {
        let current = true;
        if (!canObserve || !binding || !rows) return;
        const isCurrent = () => current && binding.isCurrent() && readCurrentProjectAccountRows(storage.getState()) === rows;
        const abort = new AbortController();
        void (async () => {
          if (!declarations.length) return [];
          const account = await captureLazyActionAccountContext(input.serverId!, abort.signal);
          try {
            if (account.accountId !== binding.accountId) throw new Error('Project Account changed');
            const facts = await readUiWorkspaceSyncChildMachineFacts(account, abort.signal);
            return await Promise.all(declarations.map(async target => {
            const selection = target.declaration!.selection;
            const serviceName = selection.kind === 'manifest' ? selection.name : target.id;
            const actual = await observeProjectServicePlacementActualV1({ workspace: { serverId: input.serverId!, refId: input.workspaceRefId! }, serviceName,
                workspaceRefs: rows.workspaceRefs, relationships: rows.relationships, ...facts,
                context: { normalizeServerId: resolveServerProfileScopeIdForIdentifier }, isCurrent,
                readSnapshot: async request => {
                    const key: LocalServiceLauncherStoreKeyInput = { machineId: request.machineId, serverId: input.serverId,
                        accountId: binding.accountId, scope: 'workspace', workspaceRoot: request.workspaceRoot, projection: 'managed_bindings' };
                    const id = JSON.stringify(key);
                    if (!subscriptions.has(id)) {
                        let previous = getLocalServiceLauncherState(key);
                        const disposeLauncher = subscribeLocalServiceLauncherStore(key, () => {
                            const next = getLocalServiceLauncherState(key);
                            const observed = previous.updatedAt !== null || previous.refreshStatus === 'error';
                            const changed = next.targetsById !== previous.targetsById
                                || next.refreshError !== previous.refreshError;
                            previous = next;
                            // This observation awaits initial hydration below. Restarting it on
                            // that same read would discard its admitted Machine census and result.
                            // A scan timestamp alone changes no binding and must not restart
                            // that census either; otherwise idle scans can keep it loading.
                            if (observed && changed) observeAgain();
                        }, {
                            ...(input.launcherSnapshotClient ? { snapshotClient: input.launcherSnapshotClient } : {}),
                            ...(input.inventorySnapshotClient ? { inventorySnapshotClient: input.inventorySnapshotClient } : {}),
                        });
                        subscriptions.set(id, { key, dispose: disposeLauncher });
                    }
                    await readLocalServiceLauncherStore(key);
                    const state = getLocalServiceLauncherState(key);
                    const snapshot = snapshotFromLocalServiceLauncherState(state);
                    if (!snapshot || state.refreshStatus === 'error') throw new Error('Service binding is unavailable');
                    return { protocolVersion: 1, snapshot };
                },
            });
            return [target.id, actual] as const;
            }));
          } finally { account.dispose(); }
        })().then(values => { if (isCurrent()) setObservation({ subscriptions, declarations, values: new Map(values) }); })
            .catch(() => { if (isCurrent()) setObservation({ subscriptions, declarations,
                values: new Map(declarations.map(target => [target.id, { status: 'unavailable' as const }])) }); });
        return () => { current = false; abort.abort(); };
    }, [binding, canObserve, change, declarations, enabled, input.serverId, input.workspaceRefId, input.launcherSnapshotClient, input.inventorySnapshotClient, rows, subscriptions]);
    const state = React.useMemo(() => {
        if (!enabled || !sourceState || !declarations.length) return sourceState;
        const values = canObserve && observation?.subscriptions === subscriptions ? observation.values : null;
        const rowIdsByTargetId = new Map<string, string>();
        const targets = sourceTargets.flatMap(target => {
            if (!declarations.includes(target)) return [target];
            // A fresh SOURCE target can change native facts without changing the
            // declaration being observed. Keep its completed binding while the
            // same census refreshes; new declarations/topology still start unread.
            const observedDeclaration = observation?.declarations.find(previous => previous.id === target.id);
            const actual = observedDeclaration && sameStrictJsonValue(observedDeclaration.declaration, target.declaration)
                && sameStrictJsonValue(observedDeclaration.workspace, target.workspace) ? values?.get(target.id) : undefined;
            if (actual?.status === 'present') {
                // Moving changes native custody, not the declared Service the person opened.
                // Keep presentation identity separate from the native target used by Actions.
                rowIdsByTargetId.set(actual.target.id, target.id);
                return [actual.target];
            }
            if (actual?.status === 'ambiguous') return [...actual.targets];
            if (actual?.status === 'absent') return [target];
            // A pending read offers no Start authority, but is not a failed observation.
            return [{ ...target, state: 'unavailable' as const,
                unavailableReason: !actual && canObserve ? 'project_service_binding_pending' : 'project_service_binding_unavailable',
                ...(actual?.status === 'unavailable' && actual.machineId ? { unavailableMachineId: actual.machineId } : {}), actions: [] }];
        });
        const projected = applyLocalServiceLauncherSnapshot(sourceState, { v: 1, machineId: sourceState.machineId!,
            ...(sourceState.sessionId ? { sessionId: sourceState.sessionId } : {}), updatedAt: sourceState.updatedAt!, targets });
        return { ...projected, rowIdsByTargetId,
            ...(!values && canObserve && sourceState.refreshStatus !== 'error' ? { refreshStatus: 'refreshing' as const } : {}) };
    }, [canObserve, declarations, enabled, observation, sourceState, sourceTargets, subscriptions]);
    const refresh = React.useCallback(async (sourceMachineId: string, sourceRefreshed: boolean) => {
        const refreshed = new Map<string, boolean>([[sourceMachineId, sourceRefreshed]]);
        for (const { key } of subscriptions.values()) {
            if (!key.serverId || !binding?.isCurrent()) return;
            if (!refreshed.has(key.machineId)) refreshed.set(key.machineId,
                await refreshLocalServiceMachine({ ...key, serverId: key.serverId, accountId: binding.accountId, isCurrent: binding.isCurrent }));
        }
    }, [binding, subscriptions]);
    return { state, refresh, binding };
}
