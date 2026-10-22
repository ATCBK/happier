import * as React from 'react';
import type { DaemonProviderConnectionsDescribeResponseV1 } from '@happier-dev/protocol/rpc';
import { describeAccountProviderConnectionsV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';

import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { providerDeclarationContext, readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { getProviderCatalogSnapshot, subscribeProviderCatalogSnapshots, type ProviderCatalogSnapshot,
    beginProviderConnectionCheckRead, getProviderConnectionCheckSnapshot, providerConnectionCheckQueryKey,
    subscribeProviderModelProjectionSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import {
    registerProviderConnectionReader,
    refreshProviderConnectionReaders,
    type ProviderConnectionRefreshScope,
} from './providerConnectionRefresh';
export type { ProviderConnectionRefreshScope } from './providerConnectionRefresh';

type Success = Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>;
type Connection = Success['connections'][number];

function accountFactsMatch(previous: Connection, next: Connection): boolean {
    // A display-only rename advances the saved revision without changing the
    // facts a Machine checked. Grants and secret bindings can change without
    // advancing that revision, so compare every other Account-derived field.
    return stableJsonStringify({ ...previous, displayName: next.displayName,
        displayNameMode: next.displayNameMode, revision: next.revision }) === stableJsonStringify(next);
}

type ProviderConnectionsState = Readonly<{
    scopeKey: string | null;
    accountScopeKey?: string;
    accountData?: Success | null;
    catalog?: ProviderCatalogSnapshot | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    data: Success | null;
    error: Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'error' }>['error'] | null;
    machineError?: Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'error' }>['error'] | null;
    accountAnswered?: boolean;
    loading: boolean;
}>;

export function useProviderConnections(input: Readonly<{
    enabled: boolean;
    active?: boolean;
    machineId: string | null;
    serverId: string | null;
    connectionId?: string;
}>) {
    // A missing addressed Home must not use the Action client's omitted-target
    // fallback to the active Home. Account reads may omit a Machine, not a Home.
    const { describeProviderConnections, ready, retryReadiness, pendingApproval, accountScope: { resolution, binding } } = useProviderActionClient(input.serverId ?? []);
    const active = input.active ?? true;
    const declarations = useDaemonMergedProjectionInputs({ machineId: input.machineId, serverId: input.serverId,
        enabled: input.enabled && active && Boolean(input.machineId) });
    const declarationProjection = declarations.phase === 'ready' ? declarations.inputs?.pluginProjectionV2 ?? null : null;
    const declarationContext = React.useMemo(() => providerDeclarationContext(input.machineId, declarationProjection),
        [input.machineId, declarationProjection]);
    const activeRef = React.useRef(active);
    activeRef.current = active;
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const readCatalogAdmission = React.useCallback(() => (
        accountLifetime && input.serverId && areServerProfileIdentifiersEquivalent(input.serverId, accountLifetime.scope.serverId)
            ? getProviderCatalogSnapshot(accountLifetime.scope) : null
    ), [accountLifetime, input.serverId]);
    // Observe admission withdrawal, not a second catalog load or a newer editor revision.
    const catalogAdmission = React.useSyncExternalStore(subscribeProviderCatalogSnapshots, readCatalogAdmission, readCatalogAdmission);
    const [state, setState] = React.useState<ProviderConnectionsState>({
        scopeKey: null,
        accountLifetime: null,
        data: null,
        error: null,
        loading: false,
    });
    const generation = React.useRef(0);
    const pendingRead = React.useRef<AbortController | null>(null);
    const currentAccountLifetimeRef = React.useRef(accountLifetime);
    currentAccountLifetimeRef.current = accountLifetime;
    const scopeKey = JSON.stringify([
        input.enabled,
        input.machineId,
        input.serverId,
        input.connectionId ?? null,
        resolution.kind === 'bound' ? serverAccountScopeKeySuffix(resolution.scope) : null,
    ]);
    const accountScopeKey = JSON.stringify([input.enabled, input.serverId, input.connectionId ?? null,
        resolution.kind === 'bound' ? serverAccountScopeKeySuffix(resolution.scope) : null]);
    const stateMatchesScope = state.scopeKey === scopeKey
        && state.accountLifetime === accountLifetime;
    const machineQueryKey = input.machineId ? providerConnectionCheckQueryKey(input.machineId, input.connectionId) : null;
    const readMachineSnapshot = React.useCallback(() => input.enabled && machineQueryKey && binding?.credentialKey
        && binding.isCurrent() && (accountLifetime?.isCurrent() ?? true)
        ? getProviderConnectionCheckSnapshot(binding.scope, binding.credentialKey, machineQueryKey) : null,
    [accountLifetime, binding, input.enabled, machineQueryKey]);
    const subscribeMachineSnapshot = React.useCallback((listener: () => void) => active && input.enabled
        && machineQueryKey && binding?.credentialKey && binding.isCurrent()
        ? subscribeProviderModelProjectionSnapshot(binding.scope, binding.credentialKey, machineQueryKey, listener) : () => {},
    [active, binding, input.enabled, machineQueryKey]);
    const cachedMachine = React.useSyncExternalStore(subscribeMachineSnapshot, readMachineSnapshot, readMachineSnapshot);
    const scopeEnabled = input.enabled;
    const accountMatchesScope = state.accountScopeKey === accountScopeKey && state.accountLifetime === accountLifetime;
    const answeredCatalog = accountMatchesScope && catalogAdmission?.data
        && state.catalog?.cryptoAdmission?.contentPublicKeyFingerprint === catalogAdmission.cryptoAdmission?.contentPublicKeyFingerprint
        ? state.catalog?.data ?? null : null;
    // A phone's list/detail transition may mount a new reader while the Home is
    // slow. Reuse the catalog owner's admitted display data until this reader
    // answers; a later catalog revision must not overwrite an editor's answer.
    const retained = React.useMemo(() => {
        if (!input.enabled || !binding?.isCurrent() || !accountLifetime?.isCurrent()
            || !areServerAccountScopesEqual(binding.scope, accountLifetime.scope)
            || !catalogAdmission?.data || accountMatchesScope && state.accountData) return null;
        return { catalog: catalogAdmission.data, data: describeAccountProviderConnectionsV1(
            catalogAdmission.data, readAccountProviderDeclarations(declarationContext), input.connectionId,
        ) };
    }, [accountLifetime, accountMatchesScope, binding, catalogAdmission, declarationContext, input.connectionId, input.enabled, state.accountData]);
    const catalog = answeredCatalog ?? retained?.catalog ?? null;
    const answeredData = state.catalog?.data && answeredCatalog === null ? null
        : stateMatchesScope ? state.data : accountMatchesScope ? state.accountData ?? null : null;
    // A mounted editor keeps the exact answer its draft read. Other readers may
    // refresh the shared last-known Machine check without changing that basis.
    const data = stateMatchesScope && state.accountAnswered ? answeredData
        : cachedMachine ?? answeredData ?? retained?.data ?? null;
    const error = stateMatchesScope ? state.error : null;
    const machineError = stateMatchesScope ? state.machineError ?? null : null;
    // Account rows are already usable while optional Machine facts refresh.
    // Consumers use loading to replace their values, so reserve it for the first answer.
    const loading = data === null && active && scopeEnabled
        && (resolution.kind === 'resolving' || resolution.kind === 'bound')
        && (!ready || !stateMatchesScope || state.loading);

    React.useEffect(() => {
        const registration = accountLifetime?.onRetire(() => {
            if (currentAccountLifetimeRef.current !== accountLifetime) return;
            generation.current += 1;
            setState((current) => current.accountLifetime === accountLifetime
                ? { scopeKey: null, accountLifetime: null, data: null, error: null, loading: false }
                : current);
        });
        return () => registration?.dispose();
    }, [accountLifetime]);

    const read = React.useCallback(async () => {
        if (!activeRef.current) return null;
        const requestGeneration = ++generation.current;
        const requestStillCurrent = (): boolean => (
            activeRef.current && currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)
            && (resolution.kind !== 'bound' || binding?.isCurrent() === true)
        );
        if (!requestStillCurrent()) return null;
        if (!input.enabled) {
            setState({ scopeKey, accountLifetime, data: null, error: null, loading: false });
            return null;
        }
        if (!ready) return null;
        pendingRead.current?.abort();
        const controller = new AbortController();
        pendingRead.current = controller;
        const machineId = input.machineId;
        const serverId = input.serverId;
        setState((current) => current.scopeKey === scopeKey
            && current.accountLifetime === accountLifetime
            ? { ...current, loading: true }
            : { scopeKey, accountScopeKey, accountLifetime,
                catalog: current.accountScopeKey === accountScopeKey && current.accountLifetime === accountLifetime ? current.catalog ?? null : null,
                data: current.accountScopeKey === accountScopeKey && current.accountLifetime === accountLifetime ? current.accountData ?? null : null,
                error: null, loading: true });
        let accountData: Success | null = null;
        let catalog: ProviderCatalogSnapshot | null = null;
        try {
            // Account configuration is readable independently of machine execution.
            // Machine facts augment that fresh projection; a failed daemon cannot hide its editor.
            const accountResult = await describeProviderConnections({
                serverId,
                ...(input.connectionId ? { connectionId: input.connectionId } : {}),
            }, { signal: controller.signal });
            if (requestGeneration !== generation.current || !requestStillCurrent()) return;
            if (accountResult.status === 'error') {
                setState({ scopeKey, accountScopeKey, accountLifetime, data: null, accountData: null,
                    error: accountResult.error, machineError: null, accountAnswered: true, loading: true });
                return null;
            }
            accountData = accountResult;
            const admitted = readCatalogAdmission();
            if (admitted?.data) {
                const revisions = new Map(accountData.connections.map(connection => [connection.connectionId, connection.revision]));
                catalog = { ...admitted, data: { ...admitted.data,
                    connections: admitted.data.connections.filter(connection => revisions.get(connection.id) === connection.revision) } };
            }
            setState((current) => {
                const sameTarget = machineId && current.scopeKey === scopeKey
                    && current.accountLifetime === accountLifetime;
                const previousAccountRows = new Map(sameTarget ? current.accountData?.connections.map(row => [row.connectionId, row]) : []);
                const previousRows = new Map(sameTarget ? current.data?.connections.map(row => [row.connectionId, row]) : []);
                const connections = accountResult.connections.map(row => {
                    const previousAccountRow = previousAccountRows.get(row.connectionId);
                    const previousRow = previousRows.get(row.connectionId);
                    if (!previousAccountRow || !previousRow || previousRow.revision !== previousAccountRow.revision
                        || !accountFactsMatch(previousAccountRow, row)) return row;
                    if (previousRow.displayName === row.displayName && previousRow.displayNameMode === row.displayNameMode
                        && previousRow.revision === row.revision) return previousRow;
                    return { ...previousRow, displayName: row.displayName, displayNameMode: row.displayNameMode, revision: row.revision };
                });
                const machineCollections = sameTarget && current.data ? {
                    discoveryCandidates: current.data.discoveryCandidates,
                    discoveryCandidatesTruncated: current.data.discoveryCandidatesTruncated,
                    localInstallations: current.data.localInstallations,
                    ...(current.data.localInstallationsStatus ? { localInstallationsStatus: current.data.localInstallationsStatus } : {}),
                } : {};
                return { scopeKey, accountScopeKey, accountLifetime, data: { ...accountResult, ...machineCollections, connections }, accountData: accountResult, catalog,
                    error: null, machineError: null, accountAnswered: true, loading: true };
            });
            if (!machineId) return accountData;
            const publishMachine = machineQueryKey && binding?.credentialKey
                ? beginProviderConnectionCheckRead(binding.scope, binding.credentialKey, machineQueryKey) : null;
            const result = await describeProviderConnections({ machineId, serverId,
                ...(input.connectionId ? { connectionId: input.connectionId } : {}),
            }, { signal: controller.signal });
            if (requestGeneration !== generation.current || !requestStillCurrent()) return;
            if (result.status === 'success') {
                publishMachine?.(result);
                const connections = new Map(result.connections.map(connection => [connection.connectionId, connection]));
                for (const connection of accountData.connections) {
                    const machineConnection = connections.get(connection.connectionId);
                    if (!machineConnection || machineConnection.revision !== connection.revision) {
                        connections.set(connection.connectionId, connection);
                    }
                }
                const augmented = { ...result, connections: [...connections.values()] };
                setState({ scopeKey, accountScopeKey, accountLifetime, data: augmented, accountData, catalog,
                    error: null, machineError: null, accountAnswered: true, loading: true });
                return augmented;
            } else {
                setState({ scopeKey, accountScopeKey, accountLifetime, data: accountData, accountData, catalog,
                    error: null, machineError: result.error, accountAnswered: true, loading: true });
            }
            return accountData;
        } catch (caught) {
            if (requestGeneration !== generation.current || !requestStillCurrent()) return;
            const failure = providerErrorFromRpcFailure(caught, {
                    ...(machineId ? { machineId } : {}),
                    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
                });
            setState({ scopeKey, accountScopeKey, accountLifetime, data: accountData, accountData, catalog,
                error: accountData ? null : failure, machineError: accountData ? failure : null, accountAnswered: accountData !== null, loading: true });
            return accountData;
        } finally {
            if (pendingRead.current === controller) pendingRead.current = null;
            if (requestGeneration === generation.current && requestStillCurrent()) {
                setState((current) => current.scopeKey === scopeKey
                    && current.accountLifetime === accountLifetime
                    ? { ...current, loading: false }
                    : current);
            }
        }
    }, [accountLifetime, binding, resolution.kind, accountScopeKey, describeProviderConnections, ready, input.connectionId, input.enabled, input.machineId, input.serverId, machineQueryKey, readCatalogAdmission, scopeKey]);

    React.useEffect(() => {
        const unregister = active && input.enabled
            ? registerProviderConnectionReader({
                targets: [{ machineId: input.machineId, serverId: input.serverId }], accountLifetime, read,
            })
            : null;
        // Visibility pauses demand; it does not change the authority of a
        // retained projection or the metadata an editor draft was built from.
        setState((current) => current.scopeKey === scopeKey && current.accountLifetime === accountLifetime
            ? current
            : { scopeKey, accountScopeKey, accountLifetime,
                catalog: current.accountScopeKey === accountScopeKey && current.accountLifetime === accountLifetime ? current.catalog ?? null : null,
                accountData: current.accountScopeKey === accountScopeKey && current.accountLifetime === accountLifetime ? current.accountData ?? null : null,
                data: current.accountScopeKey === accountScopeKey && current.accountLifetime === accountLifetime ? current.accountData ?? null : null,
                error: null, loading: false });
        void read();
        return () => {
            generation.current += 1;
            pendingRead.current?.abort();
            pendingRead.current = null;
            unregister?.();
        };
    }, [accountLifetime, accountScopeKey, active, input.enabled, input.machineId, input.serverId, read, scopeKey]);

    const refresh = React.useCallback(async (refreshScope: ProviderConnectionRefreshScope = 'machine') => {
        if (activeRef.current && input.enabled && currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)) retryReadiness();
        const ownRead = read();
        if (input.enabled
            && currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true) && binding?.isCurrent() === true) {
            // Account edits affect every machine projection on this Home;
            // runtime-only changes retain demand on the exact machine.
            refreshProviderConnectionReaders({ scope: refreshScope, machineId: input.machineId,
                serverId: input.serverId, accountLifetime, ownRead: read });
        }
        return await ownRead;
    }, [accountLifetime, binding, input.enabled, input.machineId, input.serverId, read, retryReadiness]);

    return { data, catalog, error, machineError, loading, refresh, pendingApproval, declarationProjection, declarationContext };
}
