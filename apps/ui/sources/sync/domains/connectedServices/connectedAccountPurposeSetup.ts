import { QualifiedConnectedAccountPurposeV1Schema, type QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import { readDeclaredConnectedAccountPurposeV1, resolveConnectedAccountPurposeSelectedAccountV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeSelectionV1';
import type { AccountProfile } from '@happier-dev/protocol/account/profile';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { areServerAccountScopesEqual, createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type ConnectedAccountPurposeSetupRequest = Readonly<{
    scope: ServerAccountScope;
    machineId: string;
    purpose: QualifiedConnectedAccountPurposeV1;
}>;

export function buildConnectedAccountPurposeSetupRoute(request: ConnectedAccountPurposeSetupRequest) {
    return { pathname: '/(app)/settings/connected-services/connect' as const, params: {
        purposeConsumerPlugin: request.purpose.consumer.pluginId, purposeConsumerId: request.purpose.consumer.localId,
        purpose: request.purpose.purpose, purposeServerId: request.scope.serverId,
        purposeAccountId: request.scope.accountId, purposeMachineId: request.machineId,
    } };
}

/** Route values request a choice; current Account and Resource facts supply its authority. */
export function readConnectedAccountPurposeSetupRequest(params: Readonly<Record<string, unknown>>): ConnectedAccountPurposeSetupRequest | null {
    const purpose = QualifiedConnectedAccountPurposeV1Schema.safeParse({
        consumer: { pluginId: params.purposeConsumerPlugin, localId: params.purposeConsumerId }, purpose: params.purpose,
    });
    const scope = typeof params.purposeServerId === 'string' && typeof params.purposeAccountId === 'string'
        ? createServerAccountScope(params.purposeServerId, params.purposeAccountId) : null;
    return purpose.success && scope && typeof params.purposeMachineId === 'string' && params.purposeMachineId.trim()
        ? { purpose: purpose.data, scope, machineId: params.purposeMachineId.trim() } : null;
}

export function readConnectedAccountPurposeSetupDeclaration(request: ConnectedAccountPurposeSetupRequest | null,
    viewer: ServerAccountScope | null, runtime: PluginUiProjectionCurrentness) {
    if (!request || !areServerAccountScopesEqual(viewer, request.scope) || runtime.serverId !== request.scope.serverId
        || runtime.machineId !== request.machineId || runtime.phase !== 'current' || !runtime.interactionEnabled) return null;
    return runtime.pluginUiProjection ? readDeclaredConnectedAccountPurposeV1({
        purpose: request.purpose, projection: runtime.pluginUiProjection,
        machineProvisionersById: runtime.pluginUiProjection.machineProvisionersById,
    }) : null;
}

/** The same purpose resolver used by mounted widgets admits the chosen active personal target. */
export function resolveConnectedAccountPurposeSetupSelectedAccount(input: Readonly<{
    request: ConnectedAccountPurposeSetupRequest | null; viewer: ServerAccountScope | null;
    runtime: PluginUiProjectionCurrentness; profile: AccountProfile;
    target: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
}>) {
    const declared = readConnectedAccountPurposeSetupDeclaration(input.request, input.viewer, input.runtime);
    if (!declared || !input.request || input.profile.id !== input.request.scope.accountId) return null;
    // This journey repairs a missing connection, not the independent clear-default action.
    if (!input.target) return null;
    return resolveConnectedAccountPurposeSelectedAccountV1({ purpose: input.request.purpose, serviceRefs: declared.serviceRefs,
        bindings: { v: 1, bindings: [{ purpose: input.request.purpose, target: input.target }] },
        accounts: input.profile.connectedAccountsV4, groups: input.profile.connectedAccountGroupsV4, now: Date.now(),
        readAuthentication: service => input.runtime.connectedAccountProjection?.kind === 'ready'
            ? input.runtime.connectedAccountProjection.descriptors.find(descriptor => descriptor.pluginId === service.pluginId
                && descriptor.id === service.localId && descriptor.availability.state === 'available')?.authentication ?? null : null,
    });
}

/** Provisioner setup returns an explicit input choice rather than writing a default. */
export function isConnectedAccountPurposeSetupTargetCurrent(input: Parameters<typeof resolveConnectedAccountPurposeSetupSelectedAccount>[0]): boolean {
    const declaration = readConnectedAccountPurposeSetupDeclaration(input.request, input.viewer, input.runtime);
    return Boolean(declaration && declaration.consumerKind !== 'machineProvisioner')
        && resolveConnectedAccountPurposeSetupSelectedAccount(input) !== null;
}
