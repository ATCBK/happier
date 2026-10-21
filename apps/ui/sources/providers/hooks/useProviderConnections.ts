import * as React from 'react';
import type { DaemonProviderConnectionsDescribeResponseV1 } from '@happier-dev/protocol/rpc';

import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { getProviderCatalogSnapshot, subscribeProviderCatalogSnapshots, type ProviderCatalogSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    registerProviderConnectionReader,
    refreshProviderConnectionReaders,
    type ProviderConnectionRefreshScope,
} from './providerConnectionRefresh';
export type { ProviderConnectionRefreshScope } from './providerConnectionRefresh';

type Success = Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>;
type ProviderConnectionsState = Readonly<{
    scopeKey: string | null;
    accountScopeKey?: string;
    accountData?: Success | null;
    catalog?: ProviderCatalogSnapshot | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    data: Success | null;
    error: Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'error' }>['error'] | null;
    machineError?: Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'error' }>['error'] | null;
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
    const scopeEnabled = input.enabled;
    const accountMatchesScope = state.accountScopeKey === accountScopeKey && state.accountLifetime === accountLifetime;
    const catalog = accountMatchesScope && catalogAdmission?.data
        && state.catalog?.cryptoAdmission?.contentPublicKeyFingerprint === catalogAdmission.cryptoAdmission?.contentPublicKeyFingerprint
        ? state.catalog?.data ?? null : null;
    const data = state.catalog?.data && catalog === null ? null
        : stateMatchesScope ? state.data : accountMatchesScope ? state.accountData ?? null : null;
    const error = stateMatchesScope ? state.error : null;
    const machineError = stateMatchesScope ? state.machineError ?? null : null;
    const loading = active && scopeEnabled
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
                    error: accountResult.error, machineError: null, loading: true });
                return null;
            }
            accountData = accountResult;
            const admitted = readCatalogAdmission();
            if (admitted?.data) {
                const revisions = new Map(accountData.connections.map(connection => [connection.connectionId, connection.revision]));
                catalog = { ...admitted, data: { ...admitted.data,
                    connections: admitted.data.connections.filter(connection => revisions.get(connection.id) === connection.revision) } };
            }
            setState({ scopeKey, accountScopeKey, accountLifetime, data: accountData, accountData, catalog,
                error: null, machineError: null, loading: true });
            if (!machineId) return accountData;
            const result = await describeProviderConnections({ machineId, serverId,
                ...(input.connectionId ? { connectionId: input.connectionId } : {}),
            }, { signal: controller.signal });
            if (requestGeneration !== generation.current || !requestStillCurrent()) return;
            if (result.status === 'success') {
                const connections = new Map(result.connections.map(connection => [connection.connectionId, connection]));
                for (const connection of accountData.connections) {
                    const machineConnection = connections.get(connection.connectionId);
                    if (!machineConnection || machineConnection.revision !== connection.revision) {
                        connections.set(connection.connectionId, connection);
                    }
                }
                const augmented = { ...result, connections: [...connections.values()] };
                setState({ scopeKey, accountScopeKey, accountLifetime, data: augmented, accountData, catalog,
                    error: null, machineError: null, loading: true });
                return augmented;
            } else {
                setState({ scopeKey, accountScopeKey, accountLifetime, data: accountData, accountData, catalog,
                    error: null, machineError: result.error, loading: true });
            }
            return accountData;
        } catch (caught) {
            if (requestGeneration !== generation.current || !requestStillCurrent()) return;
            const failure = providerErrorFromRpcFailure(caught, {
                    ...(machineId ? { machineId } : {}),
                    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
                });
            setState({ scopeKey, accountScopeKey, accountLifetime, data: accountData, accountData, catalog,
                error: accountData ? null : failure, machineError: accountData ? failure : null, loading: true });
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
    }, [accountLifetime, binding, resolution.kind, accountScopeKey, describeProviderConnections, ready, input.connectionId, input.enabled, input.machineId, input.serverId, readCatalogAdmission, scopeKey]);

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

    return { data, catalog, error, machineError, loading, refresh, pendingApproval };
}
