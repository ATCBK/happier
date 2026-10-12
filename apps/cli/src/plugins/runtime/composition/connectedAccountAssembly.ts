import type { PluginSourceCustody } from '../sourceAuthority';
import type { PluginRuntimeOccurrenceId } from '../runtimeSlots';
import type { ResolvedContributionRegistry } from '../../projection/registry/types';
import type { StablePluginConnectedAccountsOwner } from '../invocation/services/connectedAccounts';
import type { PluginNetworkAddressResolver } from '../fetch/originLocality';
import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountContributionRegistry } from '../connectedAccounts/contributionRegistry';
import type { HostConnectedAccountRuntimeRegistration } from '../connectedAccounts/contributionRegistry';
import { createConnectedAccountHostRuntimeInvoker } from '../connectedAccounts/runtimeInvoker';
import { resolveHostOwnedConnectedAccountConfiguredEndpoints } from '../connectedAccounts/configuredOrigins';
import type { createProductionPluginInvocationServiceOwners } from '../invocation/services/production';

type InvocationServiceOwners = ReturnType<typeof createProductionPluginInvocationServiceOwners>;

export function assembleConnectedAccountRuntime(input: Readonly<{
    descriptors: NonNullable<ResolvedContributionRegistry['connectedAccountDescriptors']>;
    hostRuntimes?: readonly HostConnectedAccountRuntimeRegistration[];
    readPluginOccurrenceId(pluginId: string): PluginRuntimeOccurrenceId | null;
    readPluginSourceCustody(pluginId: string): PluginSourceCustody | null;
    isPluginOccurrenceCurrent(pluginId: string, occurrenceId: PluginRuntimeOccurrenceId): boolean;
    activateOnDemand(ref: Readonly<{ pluginId: string; localId: string }>): Promise<void>;
    readRegistrations(): Parameters<typeof createConnectedAccountContributionRegistry>[0]['readRegistrations'] extends () => infer Result
        ? Result
        : never;
    resolvePlugin: Parameters<typeof createConnectedAccountHostRuntimeInvoker>[0]['resolvePlugin'];
    invocationServiceOwners: Pick<
        InvocationServiceOwners,
        | 'resolveInvocationHostPolicy'
        | 'createServices'
        | 'registerRawForRedaction'
        | 'redactDiagnosticText'
    >;
    onDescriptorUnavailable: Parameters<typeof createConnectedAccountContributionRegistry>[0]['onDescriptorUnavailable'];
    networkDependencies?: Readonly<{
        resolveNetworkAddresses?: PluginNetworkAddressResolver;
    }>;
}>) {
    const contributions = createConnectedAccountContributionRegistry({
        readPluginOccurrenceId: input.readPluginOccurrenceId,
        readPluginSourceCustody: input.readPluginSourceCustody,
        isPluginOccurrenceCurrent: input.isPluginOccurrenceCurrent,
        descriptors: input.descriptors,
        onDescriptorUnavailable: input.onDescriptorUnavailable,
        activateOnDemand: input.activateOnDemand,
        readRegistrations: input.readRegistrations,
    });
    for (const registration of input.hostRuntimes ?? []) contributions.registerHostConnectedAccountRuntime(registration);
    const invoker = createConnectedAccountHostRuntimeInvoker({
        resolveRuntime: contributions.resolve,
        resolvePlugin: input.resolvePlugin,
        resolveHostPolicy: input.invocationServiceOwners.resolveInvocationHostPolicy,
        createServices: input.invocationServiceOwners.createServices,
        registerRawForRedaction: input.invocationServiceOwners.registerRawForRedaction,
        redactDiagnosticText(seed, value) {
            return input.invocationServiceOwners.redactDiagnosticText({
                pluginId: seed.plugin.id,
                occurrenceId: seed.occurrenceId,
                correlationId: seed.correlationId,
            }, value);
        },
        resolveHostOwnedConfiguredEndpoints(service, configuration) {
            const contribution = contributions.list().find((candidate) => (
                candidate.ref.pluginId === service.pluginId
                && candidate.ref.localId === service.localId
            ));
            if (!contribution) {
                throw new Error('Connected-account configured origin descriptor is unavailable');
            }
            return resolveHostOwnedConnectedAccountConfiguredEndpoints({
                service,
                descriptor: contribution.descriptor,
                configuration,
            });
        },
        ...(input.networkDependencies?.resolveNetworkAddresses
            ? { resolveNetworkAddresses: input.networkDependencies.resolveNetworkAddresses }
            : {}),
    });
    return Object.freeze({ contributions, invoker });
}

export function projectConnectedAccountPurposeBindingOwner(
    owner: StablePluginConnectedAccountsOwner | undefined,
): Pick<
    ConnectedAccountPurposeBindingOwner,
    'getBinding' | 'materialize' | 'watch' | 'listAccounts'
> | null {
    return owner
        ? Object.freeze({
            getBinding: owner.getBinding,
            materialize: owner.materialize,
            watch: owner.watch,
            listAccounts: owner.listAccounts,
        })
        : null;
}
