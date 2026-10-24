import * as React from 'react';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { normalizeWorkspaceRootPathV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationMachineAddressKey, type QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { createSharedSubscriptionStore, type SharedSubscriptionStore } from '@/sync/runtime/subscriptions/sharedSubscriptionStore';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { createProjectManifestActionClient } from './projectManifestActionClient';

export type ProjectDefinitionInspection = Awaited<ReturnType<ReturnType<typeof createProjectManifestActionClient>['inspect']>>;
export type ProjectDefinitionInspectionRead =
    | Readonly<{ key: string; value: ProjectDefinitionInspection; refreshing?: boolean; error?: string }>
    | Readonly<{ key: string; error: string }>;

/** One exact checkout's identity for the inspection it belongs to. */
export function projectDefinitionInspectionKey(workspace: WorkspaceAddressV1): string {
    return `${buildWorkspaceCacheKey(workspace)}:${workspace.workspaceId}`;
}

type InspectionStore = SharedSubscriptionStore<WorkspaceAddressV1, ProjectDefinitionInspectionRead | null,
    ProjectDefinitionInspectionRead | null, typeof createProjectManifestActionClient>;
type InspectionReader = Readonly<{ workspace: WorkspaceAddressV1; store: InspectionStore; bindings: Map<() => void, ServerCredentialAccountScopeBinding> }>;

// Hook bindings have distinct object lifetimes. Share only their exact credential-backed
// display identity; every read still requires a live binding. Credential mutation evicts it.
const readers = new Map<string, InspectionReader>();
const unqualifiedReaders = new WeakMap<ServerCredentialAccountScopeBinding, Map<string, InspectionReader>>();
subscribeHomeCredentialChange(event => {
    for (const [key, reader] of readers) {
        if (!areServerProfileIdentifiersEquivalent(event.serverId, reader.workspace.serverId)) continue;
        reader.store.publish(reader.workspace, null);
        reader.store.reset();
        readers.delete(key);
    }
});

function createInspectionStore(currentBinding: () => ServerCredentialAccountScopeBinding | undefined): InspectionStore {
    const store: InspectionStore = createSharedSubscriptionStore<WorkspaceAddressV1, ProjectDefinitionInspectionRead | null,
        ProjectDefinitionInspectionRead | null, typeof createProjectManifestActionClient>({
        emptyState: null,
        createState: () => null,
        normalizeInput: input => input,
        storeKey: projectDefinitionInspectionKey,
        defaultSnapshotClient: createProjectManifestActionClient,
        retainState: true,
        beginRefresh: state => state && 'value' in state ? { ...state, refreshing: true } : state,
        refresh: async ({ input, snapshotClient, signal }) => {
            const binding = currentBinding();
            if (!binding) return null;
            const value = await snapshotClient({ workspace: input, expectedAccountId: binding.accountId, signal }).inspect();
            return current => {
                if (!binding.isCurrent() && !currentBinding()) return null;
                let facts = value;
                if (current && 'value' in current) {
                    if (sameStrictJsonValue(current.value, value)) facts = current.value;
                    else {
                        facts = { ...value };
                        for (const field of Object.keys(value) as Array<keyof ProjectDefinitionInspection>) {
                            if (sameStrictJsonValue(current.value[field], value[field])) {
                                Object.assign(facts, { [field]: current.value[field] });
                            }
                        }
                    }
                }
                return { key: projectDefinitionInspectionKey(input), value: facts, refreshing: false };
            };
        },
        failRefresh: (state, input, _now, error: unknown) => {
            if (!currentBinding()) return null;
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                ? error.code : 'project_definition_inspection_failed';
            // Machine/root/content refusals withdraw the inspection even while Account
            // credentials remain current. Transport failures retain display facts only.
            if (!state || !('value' in state) || ['permission_denied', 'not_authenticated',
                'access_denied', 'admission_unavailable', 'content_unavailable'].includes(code)) {
                return { key: projectDefinitionInspectionKey(input), error: code };
            }
            const { setupReadiness: _readiness, setupConsent: _consent, ...value } = state.value;
            return { ...state, value, refreshing: false, error: code };
        },
        applySnapshot: (_state, snapshot) => snapshot,
        subscribeRecovery: (input, refresh) => {
            const current = input;
            const binding = currentBinding()!;
            const accountId = binding.accountId;
            // Hidden time was not observed. Retain the definition for continuity, but re-read
            // setup authority on new demand. Explicit refresh while observed keeps its basis.
            const retained = store.getState(input);
            if (retained && 'value' in retained) {
                const { setupReadiness: _readiness, setupConsent: _consent, ...value } = retained.value;
                store.publish(input, { key: retained.key, value, refreshing: true });
            }
            const root = normalizeWorkspaceRootPathV1(current.rootPath);
            const serverId = binding.serverId;
            const machineKey = actionOperationMachineAddressKey({ serverId, machineId: current.machineId });
            const belongs = (operation: QualifiedActionOperation | undefined) => {
                const source = operation?.snapshot.domainRef?.kind === 'projectCommand'
                    ? operation.snapshot.domainRef.sourceWorkspace : undefined;
                return operation?.serverId === serverId && operation.snapshot.scope.accountId === accountId
                    && source?.serverId === serverId && source.machineId === current.machineId
                    && source.workspaceId === current.workspaceId && normalizeWorkspaceRootPathV1(source.rootPath) === root;
            };
            let previous = actionOperationStore.getSnapshot();
            const unsubscribe = actionOperationStore.subscribe(() => {
                const next = actionOperationStore.getSnapshot();
                if (previous.operationsByKey === next.operationsByKey
                    && previous.machineObservationByKey === next.machineObservationByKey
                    && previous.unavailableOperationKeys === next.unavailableOperationKeys) {
                    previous = next;
                    return;
                }
                const beforeObservation = previous.machineObservationByKey.get(machineKey);
                const afterObservation = next.machineObservationByKey.get(machineKey);
                let changed = beforeObservation !== afterObservation
                    && (beforeObservation !== undefined || afterObservation !== 'available');
                for (const operationKey of new Set([...previous.operationsByKey.keys(), ...next.operationsByKey.keys()])) {
                    const before = previous.operationsByKey.get(operationKey);
                    const after = next.operationsByKey.get(operationKey);
                    if (!belongs(before) && !belongs(after)) continue;
                    // Output/progress, seen and dismissal revisions are not target readiness changes.
                    if (before?.snapshot.state !== after?.snapshot.state
                        || before?.snapshot.startedAt !== after?.snapshot.startedAt
                        || before?.snapshot.settledAt !== after?.snapshot.settledAt
                        || before?.snapshot.setupReview?.reviewedEffectDigest !== after?.snapshot.setupReview?.reviewedEffectDigest
                        || before?.snapshot.observation?.kind !== after?.snapshot.observation?.kind
                        || previous.unavailableOperationKeys.has(operationKey) !== next.unavailableOperationKeys.has(operationKey)) changed = true;
                }
                previous = next;
                if (changed && currentBinding()) refresh(true);
            });
            return unsubscribe;
        },
    });
    return store;
}

function inspectionReader(workspace: WorkspaceAddressV1, binding: ServerCredentialAccountScopeBinding): InspectionReader {
    const workspaceKey = projectDefinitionInspectionKey(workspace);
    const key = binding.credentialKey ? JSON.stringify([binding.serverId, binding.accountId, binding.credentialKey, workspaceKey]) : null;
    let unqualified = unqualifiedReaders.get(binding);
    let reader = key ? readers.get(key) : unqualified?.get(workspaceKey);
    if (!reader) {
        const bindings = new Map<() => void, ServerCredentialAccountScopeBinding>();
        reader = { workspace, bindings, store: createInspectionStore(() => [...bindings.values()].find(current => current.isCurrent())) };
        if (key) readers.set(key, reader);
        else {
            if (!unqualified) { unqualified = new Map(); unqualifiedReaders.set(binding, unqualified); }
            unqualified.set(workspaceKey, reader);
        }
    }
    return reader;
}

/** One demand-owned inspection per exact checkout and credential scope; nothing here executes. */
export function useProjectDefinitionInspection(workspace: WorkspaceAddressV1 | null, binding: ServerCredentialAccountScopeBinding | null): Readonly<{
    read: ProjectDefinitionInspectionRead | null;
    retry: () => void;
}> {
    const presented = useLayoutPresentationActive();
    const key = workspace ? projectDefinitionInspectionKey(workspace) : null;
    // The semantic checkout key owns demand, not a caller's freshly allocated address object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const reader = React.useMemo(() => workspace && binding ? inspectionReader(workspace, binding) : null, [binding, key]);
    const subscribe = React.useCallback((listener: () => void) => {
        if (!presented || !binding?.isCurrent() || !reader) return () => {};
        reader.bindings.set(listener, binding);
        const dispose = reader.store.subscribe(reader.workspace, listener);
        const retirement = binding.onRetire(() => {
            reader.bindings.delete(listener);
            // A hook unmount retires its binding too. Withdraw this consumer's
            // authority without erasing display facts for a later qualified reader.
            listener();
        });
        return () => { retirement.dispose(); reader.bindings.delete(listener); dispose(); };
    }, [binding, presented, reader]);
    const getSnapshot = React.useCallback(() => binding?.isCurrent() && reader ? reader.store.getState(reader.workspace) : null, [binding, reader]);
    const read = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const retry = React.useCallback(() => { if (binding?.isCurrent() && reader) reader.store.invalidate(reader.workspace); }, [binding, reader]);
    return { read, retry };
}
