import type { ProviderSettingsV1 } from '@happier-dev/protocol';
import type { TeamCredentialProviderModelCatalogEntryV1 } from '@happier-dev/protocol/teams';
import { resolveProviderBindingCompatibilityFromSourceFactsV1, ProviderModelBindingSourceV1Schema } from '@happier-dev/protocol/providers/binding-compatibility';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import { hasProviderExperimentalConfirmation } from '@/providers/catalog/compatibility';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { teamCredentialBrokerLocalCredentialTransport } from './providerBrokerPrivateProtocol';

export type TeamCredentialModelCompatibilityInput = Pick<TeamCredentialProviderModelCatalogEntryV1,
  'descriptor' | 'application' | 'sourceFacts' | 'confirmationSource'> & Readonly<{ deliveryMode: 'brokered' | 'direct' }>;

/** The source supplies declarations; only this worker's admitted adapter and
 * this recipient's Account can establish compatibility and consent. */
export function resolveTeamCredentialModelCompatibility(input: Readonly<{
  model: TeamCredentialModelCompatibilityInput;
  lease: PluginRuntimeRegistryLease;
  agentId: string;
  providerSettings?: ProviderSettingsV1;
}>) {
  const adapter = readLeasedAgentProviderBindingAdapter(input);
  const facts = ProviderModelBindingSourceV1Schema.safeParse(input.model.sourceFacts);
  if (!adapter || !facts.success || facts.data.endpoint.id !== input.model.application.endpointTemplateId
    || facts.data.endpoint.protocol !== input.model.application.protocol) {
    throw Object.assign(new Error('provider_incompatible_with_agent'), createProviderErrorV1('provider_incompatible_with_agent'));
  }
  const brokerCredential = { kind: 'apiKey' as const, required: true, slotId: 'apiKey',
    transports: [teamCredentialBrokerLocalCredentialTransport(input.model.application.protocol)] };
  const compatibility = resolveProviderBindingCompatibilityFromSourceFactsV1({
    agentTargetKey: input.model.application.agentTargetKey, agent: adapter.support,
    adapterVersion: adapter.adapter.adapterVersion, endpoints: [facts.data.endpoint],
    credential: input.model.deliveryMode === 'brokered' ? brokerCredential : facts.data.credential,
    compatibilityOverrides: facts.data.compatibilityOverrides, model: input.model.descriptor,
  });
  let confirmed = compatibility.result.status === 'verified';
  if (compatibility.result.status === 'experimental' && input.model.confirmationSource) {
    const snapshot = input.providerSettings ? null : getActiveAccountSettingsSnapshot();
    const settings = input.providerSettings ?? (snapshot ? readProviderSettingsForCli(snapshot).settings : null);
    confirmed = settings !== null && hasProviderExperimentalConfirmation({
      providerSettings: settings, ...input.model.confirmationSource,
      agentTargetKey: input.model.application.agentTargetKey, modelId: input.model.descriptor.id,
      compatibilityFingerprint: compatibility.compatibilityFingerprint, confirmationScope: compatibility.result.confirmationScope,
    });
  }
  return { ...compatibility, confirmed };
}

export function assertTeamCredentialModelAdmission(input: Parameters<typeof resolveTeamCredentialModelCompatibility>[0]): void {
  const compatibility = resolveTeamCredentialModelCompatibility(input);
  const code = compatibility.result.status === 'incompatible' ? 'provider_incompatible_with_agent'
    : !compatibility.confirmed ? 'provider_compatibility_unverified' : null;
  if (code) throw Object.assign(new Error(code), createProviderErrorV1(code));
}
