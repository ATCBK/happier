import type { ProviderSettingsV1 } from '@happier-dev/protocol';
import type { TeamCredentialProviderModelCatalogEntryV1 } from '@happier-dev/protocol/teams';
import { resolveProviderBindingCompatibilityFromSourceFactsV1, ProviderModelBindingSourceV1Schema, type ProviderModelBindingSourceV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import { hasProviderExperimentalConfirmation } from '@/providers/catalog/compatibility';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { prepareProviderConnectionsCatalogForCli } from '@/providers/settings/hydrate';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { teamCredentialBrokerLocalCredentialTransport } from './providerBrokerPrivateProtocol';

export type TeamCredentialModelCompatibilityInput = Pick<TeamCredentialProviderModelCatalogEntryV1,
  'descriptor' | 'application' | 'sourceFacts' | 'confirmationSource'> & Readonly<{ deliveryMode: 'brokered' | 'direct' }>;

/** The source supplies declarations; only this worker's admitted adapter and
 * this recipient's Account can establish compatibility and consent. */
export async function resolveTeamCredentialModelCompatibility(input: Readonly<{
  model: TeamCredentialModelCompatibilityInput;
  lease: PluginRuntimeRegistryLease;
  agentId: string;
  providerSettings?: ProviderSettingsV1;
  providerSettingsOperationContext?: SavedSecretOperationContextV1;
  signal?: AbortSignal;
}>) {
  const adapter = readLeasedAgentProviderBindingAdapter(input);
  const facts = ProviderModelBindingSourceV1Schema.safeParse(input.model.sourceFacts);
  if (!adapter || !facts.success || facts.data.endpoint.id !== input.model.application.endpointTemplateId
    || facts.data.endpoint.protocol !== input.model.application.protocol) {
    throw Object.assign(new Error('provider_incompatible_with_agent'), createProviderErrorV1('provider_incompatible_with_agent'));
  }
  const brokerCredential = { kind: 'apiKey' as const, required: true, slotId: 'apiKey',
    transports: [teamCredentialBrokerLocalCredentialTransport(input.model.application.protocol)] } satisfies NonNullable<ProviderModelBindingSourceV1['credential']>;
  const compatibility = resolveProviderBindingCompatibilityFromSourceFactsV1({
    agentTargetKey: input.model.application.agentTargetKey, agent: adapter.support,
    adapterVersion: adapter.adapter.adapterVersion, endpoints: [facts.data.endpoint],
    credential: input.model.deliveryMode === 'brokered' ? brokerCredential : facts.data.credential,
    compatibilityOverrides: facts.data.compatibilityOverrides, model: input.model.descriptor,
  });
  let confirmed = compatibility.result.status === 'verified';
  if (compatibility.result.status === 'experimental' && input.model.confirmationSource) {
    let settings = input.providerSettings ?? null;
    if (!settings) {
      const context = input.providerSettingsOperationContext;
      const readSnapshot = () => context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
      const captured = readSnapshot();
      if (captured?.scopeKey) {
        const catalog = await prepareProviderConnectionsCatalogForCli({ expectedScopeKey: captured.scopeKey,
          operationContext: context, signal: input.signal });
        input.signal?.throwIfAborted();
        const current = readSnapshot();
        if (catalog.status !== 'ready' || !current || current.scopeKey !== captured.scopeKey) {
          throw Object.assign(new Error('Provider catalog authority is unavailable'), createProviderErrorV1('provider_settings_invalid'));
        }
        settings = readProviderSettingsForCli(current).settings;
      }
    }
    confirmed = settings !== null && hasProviderExperimentalConfirmation({
      providerSettings: settings, ...input.model.confirmationSource,
      agentTargetKey: input.model.application.agentTargetKey, modelId: input.model.descriptor.id,
      compatibilityFingerprint: compatibility.compatibilityFingerprint, confirmationScope: compatibility.result.confirmationScope,
    });
  }
  return { ...compatibility, confirmed };
}

export async function assertTeamCredentialModelAdmission(input: Parameters<typeof resolveTeamCredentialModelCompatibility>[0]): Promise<void> {
  input.signal?.throwIfAborted();
  const compatibility = await resolveTeamCredentialModelCompatibility(input);
  input.signal?.throwIfAborted();
  const code = compatibility.result.status === 'incompatible' ? 'provider_incompatible_with_agent'
    : !compatibility.confirmed ? 'provider_compatibility_unverified' : null;
  if (code) throw Object.assign(new Error(code), createProviderErrorV1(code));
}
