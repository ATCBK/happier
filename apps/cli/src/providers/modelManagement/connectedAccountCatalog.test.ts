import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS_V1, ProviderContributionV1Schema } from '@happier-dev/protocol';
import { ProviderModelDescriptorV1Schema } from '@happier-dev/protocol/models/descriptor';

import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createBrokerProviderRegistry } from '@/providers/broker/providerBroker.testkit';

import { projectConnectedAccountCatalog } from './connectedAccountCatalog';
import { projectDaemonProviderTeamCredentialRequestPolicySupportV1 } from './runtimeServices';

afterEach(() => vi.restoreAllMocks());

it('projects a thousand admitted descriptors without another per-model validation pass', async () => {
  const base = createBrokerProviderRegistry();
  const models = Array.from({ length: 1_000 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` }));
  const registry = { ...base, providersByContributionKey: new Map([...base.providersByContributionKey].map(([key, provider]) => [key, {
    ...provider,
    definition: ProviderContributionV1Schema.parse({ ...provider.definition, managedRuntime: {
      ...provider.definition.managedRuntime,
      connectedAccounts: [{ purpose: 'openai-upstream', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        endpointTemplateIds: ['cliproxyapi-openai-responses'], staticModels: models }],
    } }),
  }])) };
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected credential effect during catalog projection'); };
  // The Home target and binding store are system boundaries; selection/currentness remain real.
  const purposes = createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
    selectTarget: unexpected, materializeAccount: unexpected, projectTargetAccounts: unexpected,
    assertTargetAccountMaterializable: unexpected,
    resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Upstream' } : null,
  });
  // Observe the real validator without replacing its implementation.
  const descriptorParses = vi.spyOn(ProviderModelDescriptorV1Schema, 'parse');
  const result = await projectConnectedAccountCatalog({ registry, providerSettings: DEFAULT_PROVIDER_SETTINGS_V1,
    resolveSelection: purposes.resolveBindingIntentSelection,
    request: { machineId: 'machine-a', agentTargetKey: 'agent:happier.agent.codex/codex', sourceCatalog: true,
      connectedAccountTarget: { kind: 'account', account: {
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'account-a',
      } } },
  });
  const rows = result.groups.flatMap(group => group.rows);
  expect(rows).toHaveLength(1_000);
  expect(await result.isCurrent()).toBe(true);
  expect.soft(descriptorParses).toHaveBeenCalledTimes(0);

  const application = rows[0]!.application;
  if (!application) throw new Error('Expected the admitted broker application');
  const policies = rows.map(row => projectDaemonProviderTeamCredentialRequestPolicySupportV1({
    application, sourceRevision: result.groups[0]!.sourceRevision!, descriptor: row.descriptor,
  }));
  expect(policies).toHaveLength(1_000);
  expect.soft(policies[0]?.descriptor).toBe(rows[0]!.descriptor);
  expect(descriptorParses).toHaveBeenCalledTimes(0);
});
