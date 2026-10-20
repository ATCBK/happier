import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { getQualifiedConnectedAccountGroupV4 } from '@/sync/api/account/apiQualifiedConnectedAccountsV4';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { resolveConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import { parseToken } from '@/utils/auth/parseToken';
import {
    readConnectedServiceSettingsErrorCode,
    resolveConnectedServiceSettingsErrorMessage,
} from '@/components/settings/connectedServices/connectedServiceSettingsErrors';
import {
    createQualifiedConnectedAccountGroupsClient,
    isQualifiedConnectedAccountGroupRevisionCurrent as isCurrentGroupRevision,
    QualifiedConnectedAccountUiSourceError,
    type QualifiedConnectedAccountUiGroup,
    type QualifiedConnectedAccountUiSource,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import {
    invalidateConnectedServiceGroupsRefreshSignal,
    useConnectedServiceGroupsRefreshSignal,
} from '@/sync/domains/connectedServices/connectedServiceGroupsRefreshSignal';
import { sameQualifiedConnectedAccountGroupRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ConnectedServiceAuthGroupPolicyV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';

export type QualifiedConnectedAccountGroupsStatus =
    | 'idle'
    | 'loading'
    | 'loaded'
    | 'unsupported'
    | 'error';

export type QualifiedConnectedAccountGroupDeleteReceipt = ReturnType<
    (typeof CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1)['connectedServices.pools.delete']['parse']
>;

export type UseQualifiedConnectedAccountGroupsResult = Readonly<{
    status: QualifiedConnectedAccountGroupsStatus;
    source: QualifiedConnectedAccountUiSource | null;
    groups: readonly QualifiedConnectedAccountUiGroup[];
    error: string | null;
    mutating: boolean;
    execution?: ReturnType<typeof useMountedActionExecution>;
    refresh(): Promise<void>;
    create(params: Readonly<{
        groupId: string;
        displayName: string | null;
    }>): Promise<QualifiedConnectedAccountUiGroup | null>;
    patch(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        displayName?: string | null;
        policy?: Partial<ConnectedServiceAuthGroupPolicyV1>;
    }>): Promise<QualifiedConnectedAccountUiGroup | null>;
    delete(group: QualifiedConnectedAccountUiGroup): Promise<QualifiedConnectedAccountGroupDeleteReceipt | false>;
    addMember(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        account: QualifiedConnectedAccountRef;
    }>): Promise<QualifiedConnectedAccountUiGroup | null>;
    patchMember(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        account: QualifiedConnectedAccountRef;
        enabled?: boolean;
        priority?: number;
    }>): Promise<QualifiedConnectedAccountUiGroup | null>;
    removeMember(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        account: QualifiedConnectedAccountRef;
    }>): Promise<QualifiedConnectedAccountUiGroup | null>;
    setActiveAccount(params: Readonly<{
        group: QualifiedConnectedAccountUiGroup;
        account: QualifiedConnectedAccountRef;
        overrideRuntimeCooldown?: boolean;
    }>): Promise<QualifiedConnectedAccountUiGroup | null>;
}>;

type State = Readonly<{
    basis: LoadBasis | null;
    status: QualifiedConnectedAccountGroupsStatus;
    source: QualifiedConnectedAccountUiSource | null;
    groups: readonly QualifiedConnectedAccountUiGroup[];
    error: string | null;
}>;

type LoadBasis = Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    service: PluginContributionIdentityV1;
    source: QualifiedConnectedAccountUiSource;
}>;

const EMPTY_STATE: State = {
    basis: null,
    status: 'idle',
    source: null,
    groups: [],
    error: null,
};

function upsertGroup(
    groups: readonly QualifiedConnectedAccountUiGroup[],
    group: QualifiedConnectedAccountUiGroup,
): readonly QualifiedConnectedAccountUiGroup[] {
    const index = groups.findIndex((candidate) => (
        sameQualifiedConnectedAccountGroupRef(candidate.ref, group.ref)
    ));
    if (index === -1) return [...groups, group];
    const next = [...groups];
    next[index] = group;
    return next;
}

function isGroupRevisionConflict(error: unknown): boolean {
    const code = readConnectedServiceSettingsErrorCode(error);
    return code === 'connect_group_generation_conflict'
        || code === 'connect_group_incarnation_conflict'
        || code === 'connect_group_runtime_state_revision_conflict'
        || code === 'connect_group_source_revision_conflict';
}

export function useQualifiedConnectedAccountGroups(params: Readonly<{
    serverId: string;
    service: PluginContributionIdentityV1 | null;
}>): UseQualifiedConnectedAccountGroupsResult {
    const credentials = useAuth().credentials;
    const serverFeatures = useServerFeaturesSnapshotForServerId(params.serverId, { enabled: Boolean(credentials) });
    const negotiation = resolveConnectedAccountUiNegotiation(serverFeatures);
    const actionScope = React.useMemo(() => {
        try {
            const accountId = credentials ? parseToken(credentials.token) : null;
            return accountId ? { serverId: params.serverId, accountId } : null;
        } catch { return null; }
    }, [credentials, params.serverId]);
    const execution = useMountedActionExecution(actionScope);
    const refreshSignal = useConnectedServiceGroupsRefreshSignal();
    const [state, setState] = React.useState<State>(EMPTY_STATE);
    const [mutating, setMutating] = React.useState(false);
    const servicePluginId = params.service?.pluginId ?? '';
    const serviceLocalId = params.service?.localId ?? '';

    const service = React.useMemo<PluginContributionIdentityV1 | null>(
        () => servicePluginId && serviceLocalId
            ? { pluginId: servicePluginId, localId: serviceLocalId }
            : null,
        [serviceLocalId, servicePluginId],
    );
    const source = React.useMemo<QualifiedConnectedAccountUiSource | null>(
        () => negotiation === 'advertised-v4' ? { protocol: 'v4' } : null,
        [negotiation],
    );
    const basis = React.useMemo<LoadBasis | null>(
        () => credentials && params.serverId && service && source
            ? {
                credentials,
                serverId: params.serverId,
                service,
                source,
            }
            : null,
        [credentials, params.serverId, service, source],
    );
    const currentBasisRef = React.useRef(basis);
    currentBasisRef.current = basis;
    const stateRef = React.useRef(state);
    stateRef.current = state;
    // List responses may arrive after a local group mutation under the same
    // basis. Keep their request epoch with the hook state they are allowed to
    // replace, rather than giving a consumer its own reconciliation path.
    const groupsEpochRef = React.useRef(0);

    const load = React.useCallback(async (
        preserveGroups: readonly QualifiedConnectedAccountUiGroup[],
    ) => {
        if (!basis) {
            setState(EMPTY_STATE);
            return;
        }
        const listEpoch = ++groupsEpochRef.current;
        // Last-known-good stays visible while the list reloads: only a CHANGED
        // basis clears the previous groups.
        setState((previous) => ({
            basis,
            status: 'loading',
            source: basis.source,
            groups: previous.basis === basis ? previous.groups : [],
            error: null,
        }));
        try {
            const client = createQualifiedConnectedAccountGroupsClient({
                credentials: basis.credentials,
                service: basis.service,
                source: basis.source,
            });
            const groups = await client.list();
            if (
                currentBasisRef.current !== basis
                || groupsEpochRef.current !== listEpoch
            ) return;
            setState({
                basis,
                status: 'loaded',
                source: basis.source,
                groups,
                error: null,
            });
        } catch (error) {
            if (
                currentBasisRef.current !== basis
                || groupsEpochRef.current !== listEpoch
            ) return;
            setState({
                basis,
                status: 'error',
                source: basis.source,
                groups: preserveGroups,
                error: resolveConnectedServiceSettingsErrorMessage(error),
            });
        }
    }, [basis]);

    React.useEffect(() => {
        if (!basis) {
            setState({
                basis: null,
                status: negotiation === 'indeterminate' ? 'loading' : 'unsupported',
                source: null,
                groups: [],
                error: null,
            });
            return;
        }
        // Groups from a DIFFERENT basis are never preserved through a failure;
        // a reload under the same basis keeps what is already on screen.
        void load(
            stateRef.current.basis === basis ? stateRef.current.groups : [],
        );
    }, [basis, load, negotiation, refreshSignal]);

    const visibleState: State = state.basis === basis
        ? state
        : basis
            ? {
                basis,
                status: 'loading',
                source: null,
                groups: [],
                error: null,
            }
            : {
                basis: null,
                status: negotiation === 'indeterminate' ? 'loading' : 'unsupported',
                source: null,
                groups: [],
                error: null,
            };

    const client = React.useMemo(
        () => basis && visibleState.source
            ? createQualifiedConnectedAccountGroupsClient({
                credentials: basis.credentials,
                service: basis.service,
                source: visibleState.source,
                mutation: {
                    execute: async (actionId, input) => {
                        if (currentBasisRef.current !== basis) throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
                        const result = await execution.execute(actionId, input);
                        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
                        return result.result;
                    },
                    readGroup: async group => {
                        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
                        const account = await captureLazyActionAccountContext(basis.serverId);
                        try {
                            if (currentBasisRef.current !== basis || resolveAuthCredentialsScopeKey(account.credentials)
                                !== resolveAuthCredentialsScopeKey(basis.credentials)) {
                                throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
                            }
                            const response = await getQualifiedConnectedAccountGroupV4(account.credentials, { group, request: account.request });
                            account.assertCurrent();
                            if (currentBasisRef.current !== basis) throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
                            return response.group;
                        } finally { account.dispose(); }
                    },
                },
            })
            : null,
        [basis, execution.execute, visibleState.source],
    );

    const mutate = React.useCallback(async (
        operation: (
            client: ReturnType<typeof createQualifiedConnectedAccountGroupsClient>,
        ) => Promise<QualifiedConnectedAccountUiGroup>,
        currentGroup: QualifiedConnectedAccountUiGroup | null,
    ): Promise<QualifiedConnectedAccountUiGroup | null> => {
        if (!client) return null;
        const operationBasis = basis;
        setMutating(true);
        try {
            const group = await operation(client);
            if (
                currentBasisRef.current !== operationBasis
                || (currentGroup && !isCurrentGroupRevision({
                            state: stateRef.current,
                            basis: operationBasis,
                            group: currentGroup,
                        }) && !isCurrentGroupRevision({
                            state: stateRef.current,
                            basis: operationBasis,
                            // A same-Account refresh can already contain this exact acknowledged revision.
                            group,
                        }))
            ) return null;
            // A same-Account list refresh cannot revoke a successful create.
            // Return its current revision so the draft can continue adding members.
            const listedGroup = currentGroup ? undefined : stateRef.current.groups.find(candidate =>
                sameQualifiedConnectedAccountGroupRef(candidate.ref, group.ref));
            if (listedGroup && listedGroup.revision.incarnation !== group.revision.incarnation) {
                throw Object.assign(new Error('connect_group_incarnation_conflict'), { code: 'connect_group_incarnation_conflict' });
            }
            const appliedGroup = listedGroup ?? group;
            groupsEpochRef.current += 1;
            setState((previous) => ({
                ...previous,
                basis,
                status: 'loaded',
                groups: upsertGroup(previous.groups, appliedGroup),
                error: null,
            }));
            invalidateConnectedServiceGroupsRefreshSignal();
            return appliedGroup;
        } catch (error) {
            if (currentBasisRef.current !== operationBasis) return null;
            if (isActionApprovalDeclinedErrorCode(readConnectedServiceSettingsErrorCode(error))) return null;
            if (isGroupRevisionConflict(error)) {
                await load([]);
            }
            setState((previous) => ({
                ...previous,
                error: resolveConnectedServiceSettingsErrorMessage(error),
            }));
            return null;
        } finally {
            setMutating(false);
        }
    }, [basis, client, load]);

    return {
        status: visibleState.status,
        source: visibleState.source,
        groups: visibleState.groups,
        error: visibleState.error,
        mutating,
        execution,
        refresh: React.useCallback(
            () => load(visibleState.groups),
            [load, visibleState.groups],
        ),
        create: React.useCallback(
            (input) => mutate((activeClient) => activeClient.create(input), null),
            [mutate],
        ),
        patch: React.useCallback(
            (input) => mutate((activeClient) => activeClient.patch(input), input.group),
            [mutate],
        ),
        delete: React.useCallback(async (group) => {
            if (!client || !basis) return false;
            const operationBasis = basis;
            setMutating(true);
            try {
                if (!sameQualifiedConnectedAccountGroupRef(group.ref, {
                    service: operationBasis.service,
                    groupId: group.ref.groupId,
                })) {
                    throw new QualifiedConnectedAccountUiSourceError('qualified_connected_accounts_cross_source_ref');
                }
                if (currentBasisRef.current !== operationBasis) {
                    throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
                }
                const result = await execution.execute('connectedServices.pools.delete', {
                        group: group.ref,
                        expectedIncarnation: group.revision.incarnation,
                        expectedGeneration: group.revision.generation,
                        expectedRuntimeStateRevision: group.revision.runtimeStateRevision,
                    });
                if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
                const receipt = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.pools.delete'].parse(result.result);
                if (
                    currentBasisRef.current !== operationBasis
                    || !isCurrentGroupRevision({
                        state: stateRef.current,
                        basis: operationBasis,
                        group,
                        allowAbsent: true,
                    })
                ) return receipt;
                const remainingGroups = stateRef.current.groups.filter((candidate) => (
                    !sameQualifiedConnectedAccountGroupRef(candidate.ref, group.ref)
                ));
                groupsEpochRef.current += 1;
                setState((previous) => ({
                    ...previous,
                    basis,
                    status: 'loaded',
                    groups: remainingGroups,
                    error: null,
                }));
                await load(remainingGroups);
                return receipt;
            } catch (error) {
                if (currentBasisRef.current !== operationBasis) return false;
                if (isActionApprovalDeclinedErrorCode(readConnectedServiceSettingsErrorCode(error))) return false;
                if (isGroupRevisionConflict(error)) {
                    await load([]);
                }
                setState((previous) => ({
                    ...previous,
                    error: resolveConnectedServiceSettingsErrorMessage(error),
                }));
                return false;
            } finally {
                setMutating(false);
            }
        }, [basis, client, execution.execute, load]),
        addMember: React.useCallback(
            (input) => mutate((activeClient) => activeClient.addMember(input), input.group),
            [mutate],
        ),
        patchMember: React.useCallback(
            (input) => mutate((activeClient) => activeClient.patchMember(input), input.group),
            [mutate],
        ),
        removeMember: React.useCallback(
            (input) => mutate((activeClient) => activeClient.removeMember(input), input.group),
            [mutate],
        ),
        setActiveAccount: React.useCallback(async (input) => {
            if (!client) return null;
            const operationBasis = basis;
            setMutating(true);
            try {
                const group = await client.setActiveAccount(input);
                if (
                    currentBasisRef.current !== operationBasis
                    || !isCurrentGroupRevision({
                        state: stateRef.current,
                        basis: operationBasis,
                        group: input.group,
                    })
                ) return null;
                groupsEpochRef.current += 1;
                setState((previous) => ({
                    ...previous,
                    basis,
                    status: 'loaded',
                    groups: upsertGroup(previous.groups, group),
                    error: null,
                }));
                invalidateConnectedServiceGroupsRefreshSignal();
                return group;
            } catch (error) {
                if (currentBasisRef.current !== operationBasis) return null;
                if (isGroupRevisionConflict(error)) {
                    await load([]);
                }
                setState((previous) => ({
                    ...previous,
                    error: resolveConnectedServiceSettingsErrorMessage(error),
                }));
                throw error;
            } finally {
                setMutating(false);
            }
        }, [basis, client, load]),
    };
}
