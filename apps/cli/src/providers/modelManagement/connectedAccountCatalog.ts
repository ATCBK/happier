import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { resolveProviderBindingCompatibilityWithFingerprintV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import type { AgentProviderRequirementsV1, ProviderSettingsV1 } from '@happier-dev/protocol';
import type { DaemonProviderModelProjectionGroupV1, DaemonProviderModelProjectionRequestV1 } from '@happier-dev/protocol/rpc/providers';

import type { ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { projectManagedProviderBrokerApplication } from '@/providers/broker/applicationProjection';
import { isCLIProxyAPIBrokerApplication } from '@/providers/broker/teamCredentialBrokerSourceOwner';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import { hasProviderExperimentalConfirmation } from '@/providers/catalog/compatibility';
import { resolveProviderManagedRuntimeDeclarationV1 } from '@happier-dev/protocol/providers/contributions';
import { getProviderExperimentalConfirmationCatalogSourceKeyV1 } from '@happier-dev/protocol/providers/settings/v1';
import { ProviderModelBindingSourceV1Schema, projectProviderModelSourceStateV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import { readProviderConnectionBrokerImplementation } from '@/providers/broker/providerConnectionCpxBridge';

export type ResolveManagedProviderPurposeBindingIntentSelection = ConnectedAccountPurposeBindingOwner['resolveBindingIntentSelection'];

/** One source reader for catalog projection and source-any readiness. No Agent
 * registration, personal Gateway, credential read or compatibility is involved. */
export async function readConnectedAccountCatalogSources(input: Readonly<{
  registry: ProviderContributionRegistryView;
  target: NonNullable<DaemonProviderModelProjectionRequestV1['connectedAccountTarget']>;
  resolveSelection: ResolveManagedProviderPurposeBindingIntentSelection;
  signal?: AbortSignal;
  protocols?: readonly string[];
  endpointTemplateId?: string;
}>) {
  const provider = readProviderConnectionBrokerImplementation(input.registry);
  if (!provider?.definition.managedRuntime) return [];
  const runtime = resolveProviderManagedRuntimeDeclarationV1({ implementationIdentity: provider.identity,
    managedRuntime: provider.definition.managedRuntime });
  const service = input.target.kind === 'account' ? input.target.account.service : input.target.service;
  const signal = input.signal ?? new AbortController().signal;
  const sources = [];
  const selectionByPurpose = new Map<string, Awaited<ReturnType<ResolveManagedProviderPurposeBindingIntentSelection>> | null>();
  for (const endpoint of provider.definition.endpointTemplates) {
    if (input.protocols && !input.protocols.includes(endpoint.protocol)
      || input.endpointTemplateId && input.endpointTemplateId !== endpoint.id) continue;
    if (!provider.definition.managedRuntime.endpointTemplateIds.includes(endpoint.id)) continue;
    const families = runtime.connectedAccounts.filter(family => family.service.pluginId === service.pluginId
      && family.service.localId === service.localId && family.endpointTemplateIds?.includes(endpoint.id));
    const family = families.length === 1 ? families[0] : undefined;
    if (!family?.staticModels?.length) continue;
    let selection = selectionByPurpose.get(family.purpose);
    if (selection === undefined) {
      selection = await input.resolveSelection({ purpose: { consumer: provider.identity, purpose: family.purpose },
        target: input.target, serviceRefs: [family.service], signal }).catch(() => null);
      if (!selection || signal.aborted || !await selection.isCurrent(signal)) selection = null;
      selectionByPurpose.set(family.purpose, selection);
    }
    if (!selection) continue;
    sources.push({ provider, endpoint, family, selection });
  }
  return sources;
}

/** A credential-free projection of the exact declared upstream family. The
 * connection-shaped wire envelope is read-only: its identity never creates a
 * Provider connection, binding or grant. Confirmations name its exact source. */
export async function projectConnectedAccountCatalog(input: Readonly<{
  request: DaemonProviderModelProjectionRequestV1;
  registry: ProviderContributionRegistryView;
  support?: AgentProviderRequirementsV1;
  adapterVersion?: number;
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
  const groups: DaemonProviderModelProjectionGroupV1[] = [];
  const selections = new Set<Awaited<ReturnType<ResolveManagedProviderPurposeBindingIntentSelection>>>();
  for (const { provider, endpoint, family, selection } of await readConnectedAccountCatalogSources({
    registry: input.registry, target, resolveSelection: input.resolveSelection, signal,
    protocols: input.support?.acceptsProtocols ?? (input.request.application ? [input.request.application.protocol] : undefined),
    endpointTemplateId: input.request.application?.endpointTemplateId,
  })) {
      const protocol = endpoint.protocol;
      if (input.support && !input.support.acceptsProtocols.includes(protocol)) continue;
      const application = projectManagedProviderBrokerApplication({
        registry: input.registry,
        implementationIdentity: provider.identity,
        agentTargetKey: input.request.agentTargetKey,
        protocol,
        endpointTemplateId: endpoint.id,
      });
      if (!application || (input.request.application && !pluginJsonValuesEqual(application, input.request.application))) continue;
      if (!isCLIProxyAPIBrokerApplication(input.registry, application)) continue;
      selections.add(selection);
      const connectionId = ProviderConnectionIdSchema.parse(`connected-source:${computeCanonicalDomainSeparatedDigest(
        'happier.connected-source-model-projection.v1', [JSON.stringify(application), JSON.stringify(target)],
      )}`);
      const sourceFacts = ProviderModelBindingSourceV1Schema.parse({ endpoint: {
        id: endpoint.id, protocol: endpoint.protocol, capabilities: endpoint.capabilities,
      }, ...(provider.definition.credential ? { credential: provider.definition.credential } : {}),
        compatibilityOverrides: provider.definition.compatibilityOverrides?.filter(override =>
          override.agentTargetKey === input.request.agentTargetKey && override.protocol === protocol),
      });
      const confirmationSource = { connectionId, catalogSourceKey: getProviderExperimentalConfirmationCatalogSourceKeyV1({
        connectionId, connectedAccountTarget: target,
      }) };
      const rows: DaemonProviderModelProjectionGroupV1['rows'] = family.staticModels!.map(descriptor => {
          const compatibility = input.support && input.adapterVersion
            ? resolveProviderBindingCompatibilityWithFingerprintV1({
            agentTargetKey: input.request.agentTargetKey, agent: input.support, adapterVersion: input.adapterVersion,
            endpoints: provider.definition.endpointTemplates.filter(endpoint => endpoint.id === application.endpointTemplateId),
            credential: provider.definition.credential, compatibilityOverrides: provider.definition.compatibilityOverrides,
            model: descriptor,
          }) : projectProviderModelSourceStateV1(sourceFacts, descriptor);
          return {
            ref: { agentTargetKey: input.request.agentTargetKey, providerConnectionId: connectionId, modelId: descriptor.id },
            descriptor, application, sourceFacts, confirmationSource,
            gatewaySlots: [selection.binding], sources: { manual: false, static: true, probe: false },
            confidence: 'account_unverified', compatibility: { ...compatibility,
              confirmed: !input.request.sourceCatalog && compatibility.result.status === 'experimental'
                ? hasProviderExperimentalConfirmation({ providerSettings: input.providerSettings, connectionId,
                    connectedAccountTarget: target, agentTargetKey: input.request.agentTargetKey, modelId: descriptor.id,
                    compatibilityFingerprint: compatibility.compatibilityFingerprint, confirmationScope: compatibility.result.confirmationScope })
                : !input.request.sourceCatalog && compatibility.result.status === 'verified' },
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
        suppressedConnectedServiceIds: input.support?.authIsolation.suppressConnectedServiceIds ?? [],
        rows,
      });
  }
  return { groups, isCurrent: async () => !signal.aborted
    && (await Promise.all([...selections].map(selection => selection.isCurrent(signal)))).every(Boolean)
    && !signal.aborted };
}
