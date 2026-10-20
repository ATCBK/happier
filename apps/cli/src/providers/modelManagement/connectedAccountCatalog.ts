import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { resolveProviderBindingCompatibilityWithFingerprintV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { ProviderModelDescriptorV1Schema } from '@happier-dev/protocol/models/descriptor';
import type { AgentProviderRequirementsV1, ProviderSettingsV1 } from '@happier-dev/protocol';
import type { DaemonProviderModelProjectionGroupV1, DaemonProviderModelProjectionRequestV1 } from '@happier-dev/protocol/rpc/providers';

import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { projectManagedProviderBrokerApplication, resolveManagedProviderBrokerPurpose } from '@/providers/broker/applicationProjection';
import { isCLIProxyAPIBrokerApplication } from '@/providers/broker/teamCredentialBrokerSourceOwner';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import { hasProviderExperimentalConfirmation } from '@/providers/catalog/compatibility';

export type ResolveManagedProviderPurposeBindingIntentSelection = ConnectedAccountPurposeBindingOwner['resolveBindingIntentSelection'];

/** A credential-free projection of the exact declared upstream family. The
 * connection-shaped wire envelope is read-only: its identity never creates a
 * Provider connection, binding or grant. Confirmations name its exact source. */
export async function projectConnectedAccountCatalog(input: Readonly<{
  request: DaemonProviderModelProjectionRequestV1;
  registry: ProviderContributionRegistryView;
  support: AgentProviderRequirementsV1;
  adapterVersion: number;
  providerSettings: ProviderSettingsV1;
  resolveSelection: ResolveManagedProviderPurposeBindingIntentSelection;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  groups: DaemonProviderModelProjectionGroupV1[];
  isCurrent(): Promise<boolean>;
}>> {
  const target = input.request.connectedAccountTarget;
  if (!target) throw new TypeError('Connected Account catalog requires an exact target');
  const signal = input.signal ?? new AbortController().signal;
  const service = target.kind === 'account' ? target.account.service : target.service;
  const groups: DaemonProviderModelProjectionGroupV1[] = [];
  const selections: Awaited<ReturnType<ResolveManagedProviderPurposeBindingIntentSelection>>[] = [];
  for (const provider of input.registry.providersByContributionKey.values()) {
    if (!provider.definition.managedRuntime) continue;
    for (const protocol of input.support.acceptsProtocols) {
      const application = projectManagedProviderBrokerApplication({
        registry: input.registry,
        implementationIdentity: provider.identity,
        agentTargetKey: input.request.agentTargetKey,
        protocol,
        ...(input.request.application ? { endpointTemplateId: input.request.application.endpointTemplateId } : {}),
      });
      if (!application || (input.request.application && !pluginJsonValuesEqual(application, input.request.application))) continue;
      if (!isCLIProxyAPIBrokerApplication(input.registry, application)) continue;
      const family = resolveManagedProviderBrokerPurpose({ registry: input.registry, application, service });
      if (!family?.staticModels?.length) continue;
      const purpose = { consumer: application.implementationIdentity, purpose: family.purpose };
      const selection = await input.resolveSelection({ purpose, target, serviceRefs: [family.service], signal }).catch(() => null);
      if (!selection || signal.aborted || !await selection.isCurrent(signal)) continue;
      selections.push(selection);
      const connectionId = ProviderConnectionIdSchema.parse(`connected-source:${computeCanonicalDomainSeparatedDigest(
        'happier.connected-source-model-projection.v1', [JSON.stringify(application), JSON.stringify(target)],
      )}`);
      const rows: DaemonProviderModelProjectionGroupV1['rows'] = family.staticModels.map(descriptor => {
          const compatibility = resolveProviderBindingCompatibilityWithFingerprintV1({
            agentTargetKey: input.request.agentTargetKey, agent: input.support, adapterVersion: input.adapterVersion,
            endpoints: provider.definition.endpointTemplates.filter(endpoint => endpoint.id === application.endpointTemplateId),
            credential: provider.definition.credential, compatibilityOverrides: provider.definition.compatibilityOverrides,
            model: descriptor,
          });
          return {
            ref: { agentTargetKey: input.request.agentTargetKey, providerConnectionId: connectionId, modelId: descriptor.id },
            descriptor: ProviderModelDescriptorV1Schema.parse(descriptor), application,
            gatewaySlots: [selection.binding], sources: { manual: false, static: true, probe: false },
            confidence: 'account_unverified', compatibility: { ...compatibility,
              confirmed: compatibility.result.status === 'experimental'
                ? hasProviderExperimentalConfirmation({ providerSettings: input.providerSettings, connectionId,
                    connectedAccountTarget: target, agentTargetKey: input.request.agentTargetKey, modelId: descriptor.id,
                    compatibilityFingerprint: compatibility.compatibilityFingerprint, confirmationScope: compatibility.result.confirmationScope })
                : compatibility.result.status === 'verified' },
            endpointHealth: 'not_checked', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
          };
        });
      const sourceRevision = computeCanonicalDomainSeparatedDigest('happier.connected-source-model-catalog.v1', [
        JSON.stringify(application), JSON.stringify(target), JSON.stringify(rows.map(row => ({
          descriptor: row.descriptor, catalog: row.catalog, compatibilityFingerprint: row.compatibility.compatibilityFingerprint,
          selectedProtocol: row.compatibility.result.status === 'incompatible' ? null : row.compatibility.result.selectedProtocol,
        }))),
        ('sourceRegistryVersion' in provider.definition.catalog ? provider.definition.catalog.sourceRegistryVersion : undefined)
          ?? 'unversioned-provider-catalog',
        input.registry.providerActivationOccurrenceIdsByPluginId?.get(provider.identity.pluginId) ?? 'no-provider-activation-occurrence',
      ]);
      groups.push({
        connectionId, connectedAccountTarget: target, providerName: provider.definition.name, connectionName: selection.resolved.displayName,
        connectionRole: 'named', connectionDisplayNameMode: 'automatic', connectionRevision: 0, sourceRevision,
        modelLoadAction: 'descriptor_absent', modelLoadPreflightPolicy: null, authorization: { authorized: true },
        manualModelPolicy: 'catalog-only', supportsFreeformModelIds: false,
        suppressedConnectedServiceIds: input.support.authIsolation.suppressConnectedServiceIds,
        rows,
      });
    }
  }
  return { groups, isCurrent: async () => !signal.aborted
    && (await Promise.all(selections.map(selection => selection.isCurrent(signal)))).every(Boolean)
    && !signal.aborted };
}
