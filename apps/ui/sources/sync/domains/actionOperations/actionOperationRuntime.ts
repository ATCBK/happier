import * as React from 'react';

import type {
    ActionOperationListV1Request,
    ActionOperationListV1Response,
    ActionOperationSnapshotV1,
} from '@happier-dev/protocol';
import { projectActionOperationSnapshotForV1Reader } from '@happier-dev/protocol/actions/operations/v1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { getActionOperation, listActionOperations } from '@/sync/ops/actionOperations';
import { useActiveServerAccountScope, useAllMachines, useSocketStatus } from '@/sync/domains/state/storage';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { useMachinePresenceMembership } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import type { ActionOperationObservation } from './actionOperationStore';
import { actionOperationStore, isActionOperationTerminal, type ActionOperationStore } from './actionOperationStore';
import { selectTerminalActionOperation, type TerminalActionOperationQuery } from './actionOperationSelectors';
import { refreshActionOperationSnapshot } from './consumeActionOperationSnapshotPush';
import {
    actionOperationAddressKey,
    normalizeActionOperationServerId,
    type QualifiedActionOperation,
} from './qualifiedActionOperation';
import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';

const terminalExitReads = new WeakMap<ActiveServerAccountScopeLifetime, Map<string, Promise<void>>>();

/** Exit wakes the same daemon reader as a push, including for a Stop on another device. */
export function refreshTerminalActionOperation(query: TerminalActionOperationQuery, lifetime: ActiveServerAccountScopeLifetime): Promise<void> {
    if (!lifetime.isCurrent() || lifetime.scope.accountId !== query.accountId || lifetime.scope.serverId !== query.serverId) return Promise.resolve();
    const operation = selectTerminalActionOperation(actionOperationStore.getSnapshot(), query);
    if (!operation || isActionOperationTerminal(operation.snapshot.state)) return Promise.resolve();
    let reads = terminalExitReads.get(lifetime);
    if (!reads) {
        reads = new Map();
        terminalExitReads.set(lifetime, reads);
    }
    const key = actionOperationAddressKey({ serverId: operation.serverId, operationId: operation.snapshot.operationId });
    const pending = reads.get(key);
    if (pending) return pending;
    const controller = new AbortController();
    const retirement = lifetime.onRetire(() => controller.abort());
    const read = refreshActionOperationSnapshot({
        operation,
        shouldContinue: () => lifetime.isCurrent() && !controller.signal.aborted,
        readSnapshot: operationId => getActionOperation({
            serverId: operation.serverId, accountId: operation.snapshot.scope.accountId,
            machineId: operation.snapshot.scope.machineId, operationId,
            // An exit frame can precede operation settlement. Join its existing runner
            // rather than racing one snapshot read or starting another polling timer.
            waitForTerminal: true, signal: controller.signal,
        }),
        onSnapshot: value => actionOperationPresentationCoordinator.observe(value),
    }).finally(() => {
        retirement.dispose();
        reads.delete(key);
    });
    reads.set(key, read);
    return read;
}

export type ActionOperationMachineRuntimeScope = Readonly<{
    accountId: string;
    machineId: string;
    serverId: string;
}>;

type ListActionOperations = (params: Readonly<{
    machineId: string;
    serverId: string;
    accountId: string;
    requireCurrentDomainFacts: () => boolean;
    request?: ActionOperationListV1Request;
}>) => Promise<ActionOperationListV1Response>;

function runtimeScopeKey(scope: ActionOperationMachineRuntimeScope): string {
    return JSON.stringify([scope.accountId, scope.machineId, scope.serverId ?? null]);
}

function belongsToScope(
    operation: QualifiedActionOperation,
    scope: ActionOperationMachineRuntimeScope,
): boolean {
    return operation.serverId === scope.serverId
        && operation.snapshot.scope.accountId === scope.accountId
        && operation.snapshot.scope.machineId === scope.machineId;
}

export async function reconcileActionOperationsOnce(params: Readonly<{
    scope: ActionOperationMachineRuntimeScope;
    store?: ActionOperationStore;
    list?: ListActionOperations;
    shouldContinue?: () => boolean;
    requireCurrentDomainFacts?: true;
}>): Promise<void> {
    const store = params.store ?? actionOperationStore;
    const list = params.list ?? listActionOperations;
    const shouldContinue = params.shouldContinue ?? (() => true);
    const serverId = normalizeActionOperationServerId(params.scope.serverId);
    if (!serverId) return;
    const knownOperationKeys = new Set(
        [...store.getSnapshot().operationsByKey.values()]
            .filter((operation) => belongsToScope(operation, { ...params.scope, serverId }))
            .map((operation) => actionOperationAddressKey({
                serverId: operation.serverId,
                operationId: operation.snapshot.operationId,
            })),
    );
    const listedSnapshots: ActionOperationSnapshotV1[] = [];
    const requireCurrentDomainFacts = () => params.requireCurrentDomainFacts === true || [...store.getSnapshot().operationsByKey.values()].some(operation => (
        belongsToScope(operation, { ...params.scope, serverId })
        && !sameStrictJsonValue(operation.snapshot, projectActionOperationSnapshotForV1Reader(operation.snapshot))
    ));
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    while (shouldContinue()) {
        const response = await list({
            machineId: params.scope.machineId,
            serverId,
            accountId: params.scope.accountId,
            requireCurrentDomainFacts,
            request: cursor ? { cursor } : {},
        });
        if (!shouldContinue()) return;

        const scopedSnapshots = response.items.filter((snapshot) => (
            snapshot.scope.accountId === params.scope.accountId
            && snapshot.scope.machineId === params.scope.machineId
        ));
        listedSnapshots.push(...scopedSnapshots);

        if (!response.nextCursor || seenCursors.has(response.nextCursor)) break;
        seenCursors.add(response.nextCursor);
        cursor = response.nextCursor;
    }

    if (!shouldContinue()) return;
    store.reconcileMachineProjection({
        serverId,
        accountId: params.scope.accountId,
        machineId: params.scope.machineId,
        snapshots: listedSnapshots,
        knownOperationKeys,
    });
}

export type ActionOperationMachineObserver = Readonly<{
    start(): void;
    stop(): void;
}>;

function createActionOperationMachineObserver(params: Readonly<{
    scope: ActionOperationMachineRuntimeScope;
    store?: ActionOperationStore;
    reconcileOnce?: typeof reconcileActionOperationsOnce;
}>): ActionOperationMachineObserver {
    const store = params.store ?? actionOperationStore;
    const reconcileOnce = params.reconcileOnce ?? reconcileActionOperationsOnce;
    let stopped = true;

    const run = async (): Promise<void> => {
        try {
            await reconcileOnce({
                scope: params.scope,
                store,
                shouldContinue: () => !stopped,
            });
        } catch {
            if (stopped) return;
            store.setMachineObservation(
                { serverId: params.scope.serverId, machineId: params.scope.machineId },
                'reconnecting',
            );
        }
    };

    return {
        start() {
            if (!stopped) return;
            stopped = false;
            void run();
        },
        stop() {
            if (stopped) return;
            stopped = true;
        },
    };
}

export function createActionOperationRuntimeCoordinator(params?: Readonly<{
    createObserver?: (scope: ActionOperationMachineRuntimeScope) => ActionOperationMachineObserver;
}>) {
    const observers = new Map<string, ActionOperationMachineObserver>();
    const createObserver = params?.createObserver ?? ((scope) => createActionOperationMachineObserver({ scope }));

    return {
        reconcile(scopes: readonly ActionOperationMachineRuntimeScope[]): void {
            const nextScopes = new Map<string, ActionOperationMachineRuntimeScope>();
            for (const scope of scopes) nextScopes.set(runtimeScopeKey(scope), scope);

            for (const [key, observer] of observers) {
                if (nextScopes.has(key)) continue;
                observer.stop();
                observers.delete(key);
            }
            for (const [key, scope] of nextScopes) {
                if (observers.has(key)) continue;
                const observer = createObserver(scope);
                observers.set(key, observer);
                observer.start();
            }
        },
        stopAll(): void {
            for (const observer of observers.values()) observer.stop();
            observers.clear();
        },
    };
}

export function bindActionOperationRuntimeToAccountLifetime(params: Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    coordinator: Readonly<{ stopAll(): void }>;
    store?: ActionOperationStore;
}>): Readonly<{ dispose(): void }> {
    const store = params.store ?? actionOperationStore;
    return params.lifetime.onRetire(() => {
        params.coordinator.stopAll();
        store.reset();
        actionOperationPresentationCoordinator.reset();
    });
}

export function ActionOperationRuntime(): null {
    const accountScope = useActiveServerAccountScope();
    const membership = useMachinePresenceMembership(accountScope?.serverId ?? null);
    const machines = useAllMachines();
    const socket = useSocketStatus();
    const coordinator = React.useMemo(() => createActionOperationRuntimeCoordinator(), []);
    const accountLifetimeRef = React.useRef<ActiveServerAccountScopeLifetime | null>(null);
    const onlineMachineIds = membership.selectableMachineIds;
    const onlineMachineIdsKey = onlineMachineIds.join('\u0001');
    const accountId = accountScope?.accountId;
    const serverId = accountScope?.serverId;
    const scopes = React.useMemo<readonly ActionOperationMachineRuntimeScope[]>(() => {
        if (!accountId || !serverId || socket.status !== 'connected') return [];
        return onlineMachineIds.map((machineId) => ({ accountId, machineId, serverId }));
    }, [accountId, onlineMachineIdsKey, serverId, socket.status]);

    React.useEffect(() => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || lifetime.scope.accountId !== accountId || lifetime.scope.serverId !== serverId) {
            coordinator.stopAll();
            actionOperationStore.reset();
            actionOperationPresentationCoordinator.reset();
            accountLifetimeRef.current = null;
            return;
        }
        if (accountLifetimeRef.current && accountLifetimeRef.current !== lifetime) {
            coordinator.stopAll();
            actionOperationStore.reset();
            actionOperationPresentationCoordinator.reset();
        }
        accountLifetimeRef.current = lifetime;
        const retirement = bindActionOperationRuntimeToAccountLifetime({ lifetime, coordinator });
        coordinator.reconcile(scopes);
        return () => retirement.dispose();
    }, [accountId, coordinator, scopes, serverId]);

    React.useEffect(() => {
        if (!accountId || !serverId) return;
        actionOperationStore.retainAccountMachines({
            accountId,
            serverId,
            machineIds: new Set(machines.map((machine) => machine.id)),
        });
    }, [accountId, machines, serverId]);

    React.useEffect(() => {
        if (!accountId || !serverId || socket.status === 'connected') return;
        const observation: ActionOperationObservation = socket.status === 'error'
            ? 'unavailable'
            : 'reconnecting';
        for (const machineId of onlineMachineIds) {
            actionOperationStore.setMachineObservation({ serverId, machineId }, observation);
        }
    }, [accountId, onlineMachineIdsKey, serverId, socket.status]);

    React.useEffect(() => () => {
        coordinator.stopAll();
        actionOperationStore.reset();
        actionOperationPresentationCoordinator.reset();
        accountLifetimeRef.current = null;
    }, [coordinator]);
    return null;
}

/** Observation ingress for non-polling callers; daemon state remains canonical. */
export function publishActionOperationObservation(input: Readonly<{
    serverId: string | null;
    machineId: string;
    observation: ActionOperationObservation;
    snapshots?: readonly ActionOperationSnapshotV1[];
}>): void {
    const serverId = normalizeActionOperationServerId(input.serverId);
    if (!serverId) return;
    if (input.snapshots) actionOperationStore.mergeSnapshots({ serverId, snapshots: input.snapshots });
    actionOperationStore.setMachineObservation(
        { serverId, machineId: input.machineId },
        input.observation,
    );
}
