import * as React from 'react';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';

import {
    providerSettingsMachineRowKey,
    type ProviderSettingsMachineRowV1,
} from '@/providers/hooks/targetMachine';
import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { registerProviderConnectionReader, type ProviderConnectionReadTarget } from './providerConnectionRefresh';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

export type ProviderConnectionMachineViewState =
    | Readonly<{ status: 'loading'; connection: DaemonProviderConnectionViewV1 | null }>
    | Readonly<{ status: 'success'; connection: DaemonProviderConnectionViewV1 | null }>
    | Readonly<{ status: 'error'; error: ProviderErrorV1 }>;

type ProviderConnectionMachineViewsState = Readonly<{
    scopeKey: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    byTargetKey: Readonly<Record<string, ProviderConnectionMachineViewState>>;
    accountScopesByTargetKey: Readonly<Record<string, ServerAccountScope>>;
    loading: boolean;
}>;

const sameAccountScope = (left: ServerAccountScope | undefined, right: ServerAccountScope | undefined) => (
    (!left && !right) || areServerAccountScopesEqual(left, right)
);

/**
 * Per-machine daemon facts for one Provider connection. Each row is addressed
 * by its full `{ serverIdentityId, machineId }` tuple and requested through
 * that row's own server profile, so a machine id shared by two profiles can
 * never be read from the wrong daemon.
 */
export function useProviderConnectionMachineViews(input: Readonly<{
    enabled: boolean;
    active?: boolean;
    connectionId: string;
    targets: readonly ProviderSettingsMachineRowV1[];
}>) {
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [state, setState] = React.useState<ProviderConnectionMachineViewsState>({
        scopeKey: null,
        accountLifetime: null,
        byTargetKey: {},
        accountScopesByTargetKey: {},
        loading: false,
    });
    const generation = React.useRef(0);
    const latestReadByTarget = React.useRef(new Map<string, AbortController>());
    const activeRef = React.useRef(input.active !== false);
    activeRef.current = input.active !== false;
    const targetsRef = React.useRef(input.targets);
    targetsRef.current = input.targets;
    const targetsKey = JSON.stringify(
        input.targets
            .map((row) => [providerSettingsMachineRowKey(row.target), row.serverId] as const)
            .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
    );
    const { describeProviderConnections, ready, pendingApproval, scopeStates: credentialStates, scopeKey: actionScopeKey } = useProviderActionClient(input.targets.map(row => row.serverId));
    const scopeKey = JSON.stringify([input.enabled, input.connectionId, targetsKey, actionScopeKey]);
    const accountScopesByTargetKey = React.useMemo(() => {
        const scopes: Record<string, ServerAccountScope> = {};
        for (const row of input.targets) {
            const resolution = credentialStates.get(resolveServerProfileScopeIdForIdentifier(row.serverId))?.resolution;
            if (resolution?.kind === 'bound') scopes[providerSettingsMachineRowKey(row.target)] = resolution.scope;
        }
        return scopes;
    }, [credentialStates, targetsKey]);
    const scopeEnabled = input.enabled && input.targets.length > 0;
    const stateMatchesScope = state.scopeKey === scopeKey
        && state.accountLifetime === accountLifetime;
    const stateMatchesPeerAccounts = Object.keys(state.byTargetKey).every(key => sameAccountScope(
        state.accountScopesByTargetKey[key], accountScopesByTargetKey[key],
    ));
    const byTargetKey = React.useMemo(() => {
        if (!stateMatchesScope) return {};
        if (stateMatchesPeerAccounts) return state.byTargetKey;
        return Object.fromEntries(Object.entries(state.byTargetKey).map(([key, view]) => [key,
            sameAccountScope(state.accountScopesByTargetKey[key], accountScopesByTargetKey[key])
                ? view
                : { status: 'loading', connection: null } satisfies ProviderConnectionMachineViewState,
        ]));
    }, [accountScopesByTargetKey, state, stateMatchesPeerAccounts, stateMatchesScope]);
    const currentAccountLifetimeRef = React.useRef(accountLifetime);
    currentAccountLifetimeRef.current = accountLifetime;

    React.useEffect(() => {
        const registration = accountLifetime?.onRetire(() => {
            if (currentAccountLifetimeRef.current !== accountLifetime) return;
            generation.current += 1;
            setState((current) => current.accountLifetime === accountLifetime
                ? { scopeKey: null, accountLifetime: null, byTargetKey: {}, accountScopesByTargetKey: {}, loading: false }
                : current);
        });
        return () => registration?.dispose();
    }, [accountLifetime]);

    const read = React.useCallback(async (requestedTargets?: readonly ProviderConnectionReadTarget[]) => {
        if (!activeRef.current) return;
        const requestGeneration = generation.current;
        const requestStillCurrent = (): boolean => (
            activeRef.current && generation.current === requestGeneration
            && currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)
        );
        if (!requestStillCurrent()) return;
        if (!input.enabled || targetsRef.current.length === 0) {
            setState({ scopeKey, accountLifetime, byTargetKey: {}, accountScopesByTargetKey: {}, loading: false });
            return;
        }
        const targets = requestedTargets
            ? targetsRef.current.filter(row => requestedTargets.some(target =>
                target.serverId === row.serverId && target.machineId === row.target.machineId))
            : targetsRef.current;
        if (targets.length === 0) return;
        if (!ready) return;
        const requestControllers = new Map<string, AbortController>();
        for (const row of targets) {
            const key = providerSettingsMachineRowKey(row.target);
            latestReadByTarget.current.get(key)?.abort();
            const controller = new AbortController();
            requestControllers.set(key, controller);
            latestReadByTarget.current.set(key, controller);
        }
        setState((current) => {
            const previousByTargetKey = current.scopeKey === scopeKey
                && current.accountLifetime === accountLifetime
                ? current.byTargetKey
                : {};
            return {
                scopeKey,
                accountLifetime,
                accountScopesByTargetKey,
                byTargetKey: { ...previousByTargetKey, ...Object.fromEntries(targets.map((row) => {
                    const key = providerSettingsMachineRowKey(row.target);
                    const previous = sameAccountScope(current.accountScopesByTargetKey[key], accountScopesByTargetKey[key])
                        ? previousByTargetKey[key]
                        : undefined;
                    return [key, {
                        status: 'loading',
                        connection: previous?.status === 'success' || previous?.status === 'loading'
                            ? previous.connection
                            : null,
                    } satisfies ProviderConnectionMachineViewState];
                })) },
                loading: true,
            };
        });
        const entries = await Promise.all(targets.map(async (row) => {
            const key = providerSettingsMachineRowKey(row.target);
            const machineId = row.target.machineId;
            const binding = credentialStates.get(resolveServerProfileScopeIdForIdentifier(row.serverId))?.binding;
            if (!binding || !binding.isCurrent()) {
                return [key, { status: 'error', error: createProviderErrorV1('provider_authorization_changed', {
                    connectionId: input.connectionId, machineId,
                }) } satisfies ProviderConnectionMachineViewState] as const;
            }
            try {
                const result = await describeProviderConnections({
                    machineId, serverId: row.serverId, connectionId: input.connectionId,
                }, { signal: requestControllers.get(key)!.signal });
                if (!binding.isCurrent()) return [key, { status: 'error',
                    error: createProviderErrorV1('provider_authorization_changed', { connectionId: input.connectionId, machineId }),
                } satisfies ProviderConnectionMachineViewState] as const;
                return [key, result.status === 'success'
                    ? { status: 'success', connection: result.connections.find(connection => connection.connectionId === input.connectionId) ?? null } satisfies ProviderConnectionMachineViewState
                    : { status: 'error', error: result.error } satisfies ProviderConnectionMachineViewState] as const;
            } catch (caught) {
                return [key, { status: 'error', error: providerErrorFromRpcFailure(caught, {
                    connectionId: input.connectionId, machineId,
                }) } satisfies ProviderConnectionMachineViewState] as const;
            }
        }));
        if (!requestStillCurrent()) return;
        setState(current => {
            if (current.scopeKey !== scopeKey || current.accountLifetime !== accountLifetime) return current;
            const byTargetKey = { ...current.byTargetKey };
            for (const [key, entry] of entries) {
                if (latestReadByTarget.current.get(key) === requestControllers.get(key)) {
                    byTargetKey[key] = entry;
                }
            }
            return { ...current, byTargetKey, loading: Object.values(byTargetKey).some(entry => entry.status === 'loading') };
        });
    }, [accountLifetime, accountScopesByTargetKey, credentialStates, describeProviderConnections, input.connectionId, input.enabled, ready, scopeKey, targetsKey]);

    React.useEffect(() => {
        const unregister = input.active !== false && scopeEnabled
            ? registerProviderConnectionReader({
                targets: targetsRef.current.map(row => ({ machineId: row.target.machineId, serverId: row.serverId })),
                accountLifetime,
                read,
            })
            : null;
        void read();
        return () => {
            generation.current += 1;
            for (const controller of latestReadByTarget.current.values()) controller.abort();
            latestReadByTarget.current.clear();
            unregister?.();
        };
    }, [accountLifetime, input.active, read, scopeEnabled, scopeKey]);

    const refresh = React.useCallback(async () => { await read(); }, [read]);

    return {
        byTargetKey,
        loading: input.active !== false && scopeEnabled && (!stateMatchesScope || !stateMatchesPeerAccounts || state.loading),
        refresh,
        pendingApproval,
    };
}
