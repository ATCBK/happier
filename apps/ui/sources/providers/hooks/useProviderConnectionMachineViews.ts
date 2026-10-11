import * as React from 'react';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';

import {
    providerSettingsMachineRowKey,
    type ProviderSettingsMachineRowV1,
} from '@/providers/hooks/targetMachine';
import { describeProviderConnections, providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useServerCredentialAccountScopeStates } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
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

const onExecuted = () => {};
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
    const credentialStates = useServerCredentialAccountScopeStates(input.targets.map(row => row.serverId));
    const [state, setState] = React.useState<ProviderConnectionMachineViewsState>({
        scopeKey: null,
        accountLifetime: null,
        byTargetKey: {},
        accountScopesByTargetKey: {},
        loading: false,
    });
    const generation = React.useRef(0);
    const requestControllerRef = React.useRef<AbortController | null>(null);
    const activeRef = React.useRef(input.active !== false);
    activeRef.current = input.active !== false;
    const targetsRef = React.useRef(input.targets);
    targetsRef.current = input.targets;
    const targetsKey = JSON.stringify(
        input.targets
            .map((row) => [providerSettingsMachineRowKey(row.target), row.serverId] as const)
            .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
    );
    const scopeKey = JSON.stringify([input.enabled, input.connectionId, targetsKey]);
    const accountScopesByTargetKey = React.useMemo(() => {
        const scopes: Record<string, ServerAccountScope> = {};
        for (const row of input.targets) {
            const resolution = credentialStates.get(resolveServerProfileScopeIdForIdentifier(row.serverId))?.resolution;
            if (resolution?.kind === 'bound') scopes[providerSettingsMachineRowKey(row.target)] = resolution.scope;
        }
        return scopes;
        // The qualified target key captures the exact set, independent of array identity.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [credentialStates, targetsKey]);
    const approval = useActionApprovalContinuation({
        scopeKey: JSON.stringify([scopeKey, accountLifetime?.scope ?? null]),
        serverId: accountLifetime?.scope.serverId ?? '',
        onExecuted,
    });
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
            requestControllerRef.current?.abort();
            generation.current += 1;
            setState((current) => current.accountLifetime === accountLifetime
                ? { scopeKey: null, accountLifetime: null, byTargetKey: {}, accountScopesByTargetKey: {}, loading: false }
                : current);
        });
        return () => registration?.dispose();
    }, [accountLifetime]);

    const refresh = React.useCallback(async () => {
        if (!activeRef.current) return;
        requestControllerRef.current?.abort();
        const requestGeneration = ++generation.current;
        const requestStillCurrent = (): boolean => (
            currentAccountLifetimeRef.current === accountLifetime
            && (accountLifetime?.isCurrent() ?? true)
        );
        if (!requestStillCurrent()) return;
        const targets = targetsRef.current;
        if (!input.enabled || targets.length === 0) {
            setState({ scopeKey, accountLifetime, byTargetKey: {}, accountScopesByTargetKey: {}, loading: false });
            return;
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
                byTargetKey: Object.fromEntries(targets.map((row) => {
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
                })),
                loading: true,
            };
        });
        // Resolve the whole target set before dispatch: a later peer binding
        // must not restart an already queued approval for another Home.
        if (targets.some(row => {
            const credential = credentialStates.get(resolveServerProfileScopeIdForIdentifier(row.serverId));
            return !credential || credential.resolution.kind === 'resolving'
                || (credential.resolution.kind === 'bound' && !credential.binding);
        })) return;
        const requestController = new AbortController();
        requestControllerRef.current = requestController;
        const entries = await Promise.all(targets.map(async (row) => {
            const key = providerSettingsMachineRowKey(row.target);
            const machineId = row.target.machineId;
            const binding = credentialStates.get(resolveServerProfileScopeIdForIdentifier(row.serverId))?.binding;
            if (!binding || !binding.isCurrent()) {
                return [key, { status: 'error', error: createProviderErrorV1('provider_authorization_changed', {
                    connectionId: input.connectionId, machineId,
                }) } satisfies ProviderConnectionMachineViewState] as const;
            }
            const peerController = new AbortController();
            const retirement = binding.onRetire(() => peerController.abort());
            const merged = mergeAbortSignals([requestController.signal, peerController.signal]);
            try {
                const result = await describeProviderConnections({
                    machineId,
                    serverId: row.serverId,
                    connectionId: input.connectionId,
                }, {
                    scope: binding.scope,
                    signal: merged.signal,
                    onApprovalPending: registration => {
                        if (binding.isCurrent() && !merged.signal.aborted) approval.requestApproval(registration);
                    },
                });
                return [key, result.status === 'success'
                    ? {
                        status: 'success',
                        connection: result.connections.find((connection) => connection.connectionId === input.connectionId) ?? null,
                    } satisfies ProviderConnectionMachineViewState
                    : { status: 'error', error: result.error } satisfies ProviderConnectionMachineViewState] as const;
            } catch (caught) {
                return [key, {
                    status: 'error',
                    error: providerErrorFromRpcFailure(caught, {
                        connectionId: input.connectionId,
                        machineId,
                    }),
                } satisfies ProviderConnectionMachineViewState] as const;
            } finally {
                retirement.dispose();
                merged.dispose();
            }
        }));
        if (requestControllerRef.current === requestController) requestControllerRef.current = null;
        if (generation.current !== requestGeneration || !requestStillCurrent()) return;
        setState({ scopeKey, accountLifetime, byTargetKey: Object.fromEntries(entries), accountScopesByTargetKey, loading: false });
    }, [accountLifetime, accountScopesByTargetKey, approval.requestApproval, credentialStates, input.connectionId, input.enabled, scopeKey, targetsKey]);

    React.useEffect(() => {
        void refresh();
        return () => { generation.current += 1; requestControllerRef.current?.abort(); };
    }, [accountLifetime, input.active, refresh, scopeKey]);

    return {
        byTargetKey,
        loading: input.active !== false && scopeEnabled && (!stateMatchesScope || !stateMatchesPeerAccounts || state.loading),
        refresh,
    };
}
