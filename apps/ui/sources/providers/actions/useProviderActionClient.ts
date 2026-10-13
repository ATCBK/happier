import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';

import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useServerCredentialAccountScopeStates } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { retryServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveMachineRpcTargetServerId } from '@/sync/runtime/orchestration/serverScopedRpc/resolveMachineRpcTargetServerId';
import * as client from './client';

const onExecuted = () => {};

/** The Inbox page of one queued Provider approval, on the Home that holds it. */
export function providerApprovalHref(artifactId: string, transportServerId: string): string {
    return buildApprovalHref(artifactId, transportServerId);
}

/** The approval a Provider request from this client is waiting for: what to reopen, and where. */
export type ProviderPendingApproval = Readonly<{ artifactId: string; href: string }>;

/** Mounted result custody for the exact Home/Account that authored a Provider request. */
export function useProviderActionClient(serverId: string | null | readonly (string | null)[], initiatingLifetime?: ServerAccountScopeLifetime | null) {
    const resolvedServerIds = [...new Set((typeof serverId === 'string' || serverId === null ? [serverId] : serverId)
        .map(id => resolveMachineRpcTargetServerId(id))
        .filter((id): id is string => Boolean(id)))].sort();
    const serverIdsKey = JSON.stringify(resolvedServerIds);
    // The exact Home set, not a caller's freshly allocated array, owns these captures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const requestedServerIds = React.useMemo(() => resolvedServerIds, [serverIdsKey]);
    const scopeStates = useServerCredentialAccountScopeStates(requestedServerIds);
    const bindings = React.useMemo(() => new Map([...scopeStates].flatMap(([id, state]) => (
        state.binding ? [[id, state.binding] as const] : []
    ))), [scopeStates]);
    const unreadableServerIdsKey = JSON.stringify(requestedServerIds.filter(id => (
        scopeStates.get(resolveServerProfileScopeIdForIdentifier(id))?.resolution.kind === 'unavailable'
    )));
    const retryReadiness = React.useCallback(() => {
        for (const id of JSON.parse(unreadableServerIdsKey) as string[]) retryServerCredentialAccountScope(id);
    }, [unreadableServerIdsKey]);
    const lifetimes = React.useMemo(() => new Map(requestedServerIds.flatMap(id => {
        const binding = bindings.get(resolveServerProfileScopeIdForIdentifier(id));
        if (!binding) return [];
        const lifetime = {
            binding, transportServerId: getServerProfileById(id)?.id ?? id, controller: new AbortController(),
        };
        return [[resolveServerProfileScopeIdForIdentifier(id), lifetime] as const];
    })), [bindings, requestedServerIds]);
    React.useEffect(() => {
        // React's development effect replay must restore local interest, not a retired Account.
        const retirements = [...lifetimes.values()].map(lifetime => {
            if (lifetime.controller.signal.aborted) lifetime.controller = new AbortController();
            const controller = lifetime.controller;
            const retirement = lifetime.binding.onRetire(() => controller.abort());
            return () => { retirement.dispose(); controller.abort(); };
        });
        return () => { for (const retire of retirements) retire(); };
    }, [lifetimes]);
    const scopeKey = JSON.stringify(requestedServerIds.map(id => {
        const binding = bindings.get(resolveServerProfileScopeIdForIdentifier(id));
        return binding ? [serverAccountScopeKeySuffix(binding.scope), binding.revision] : ['unbound', id];
    }));
    const approval = useActionApprovalContinuation({ scopeKey, serverId: requestedServerIds[0] ?? '', onExecuted });
    // Where each queued approval was opened, so the author can reopen the same page.
    const approvalHrefsRef = React.useRef(new Map<string, string>());
    const methods = React.useMemo(() => {
        function bind<Input extends Readonly<{ serverId: string | null }>, Output>(
            method: (input: Input, approval?: client.ProviderActionApprovalOptions) => Promise<Output>,
        ): (input: Input) => Promise<Output> {
            return async input => {
                const targetServerId = input.serverId ?? (requestedServerIds.length === 1 ? requestedServerIds[0] : null);
                const lifetime = targetServerId ? lifetimes.get(resolveServerProfileScopeIdForIdentifier(targetServerId)) : undefined;
                const binding = lifetime?.binding;
                if (!binding || !lifetime || !binding.isCurrent() || lifetime.controller.signal.aborted
                    || initiatingLifetime === null || (initiatingLifetime && (!initiatingLifetime.isCurrent()
                        || !areServerAccountScopesEqual(initiatingLifetime.scope, binding.scope)))) {
                    throw createProviderErrorV1('provider_authorization_changed');
                }
                return method(input, {
                    scope: binding.scope,
                    signal: lifetime.controller.signal,
                    onApprovalPending: registration => {
                        if (!binding.isCurrent() || lifetime.controller.signal.aborted) return;
                        const artifactId = typeof registration === 'string' ? registration : registration.artifactId;
                        const href = providerApprovalHref(artifactId, lifetime.transportServerId);
                        approvalHrefsRef.current.set(artifactId, href);
                        approval.requestApproval(registration);
                    },
                });
            };
        }
        return {
            describeProviderConnections: bind(client.describeProviderConnections),
            mutateProviderConnection: bind(client.mutateProviderConnection),
            probeProviderConnection: bind(client.probeProviderConnection),
            probeProviderDraft: bind(client.probeProviderDraft),
            describeProviderModels: bind(client.describeProviderModels),
            describeProviderConnectionModels: bind(client.describeProviderConnectionModels),
            loadProviderModel: bind(client.loadProviderModel),
            cancelProviderModelLoad: bind(client.cancelProviderModelLoad),
            mutateProviderModelSettings: bind(client.mutateProviderModelSettings),
            setProviderModelPickerVisibility: bind(client.setProviderModelPickerVisibility),
            setProviderDefaultModelSelection: bind(client.setProviderDefaultModelSelection),
            describeProviderBindingStatus: bind(client.describeProviderBindingStatus),
            prepareLegacyProfileMigrationSource: bind(client.prepareLegacyProfileMigrationSource),
            previewLegacyProfileMigration: bind(client.previewLegacyProfileMigration),
            confirmLegacyProfileMigration: bind(client.confirmLegacyProfileMigration),
            confirmLegacyProfileMigrationConflict: bind(client.confirmLegacyProfileMigrationConflict),
        };
    }, [approval.requestApproval, initiatingLifetime, lifetimes, requestedServerIds]);
    const pendingApprovalHref = approval.approvalPending && approval.approvalId
        ? approvalHrefsRef.current.get(approval.approvalId) ?? null : null;
    const pendingApproval = React.useMemo<ProviderPendingApproval | null>(() => (
        approval.approvalId && pendingApprovalHref ? { artifactId: approval.approvalId, href: pendingApprovalHref } : null
    ), [approval.approvalId, pendingApprovalHref]);
    // Readiness means the credential read settled, not that it authorized an
    // Action. Terminal refusals must reach bind's typed error rather than leave
    // every read hook waiting forever. bind remains the authority check.
    return { ...methods, scopeKey, pendingApproval, retryReadiness, ready: requestedServerIds.every(id => {
        const state = scopeStates.get(resolveServerProfileScopeIdForIdentifier(id));
        if (!state || state.resolution.kind === 'resolving') return false;
        return state.resolution.kind !== 'bound' || state.binding?.isCurrent() === true;
    }) };
}
