import { describe, expect, it } from 'vitest';
import { createProviderActionExecuteV1 } from './executeProviderActionV1.js';
import { parseProviderActionRequestV1 } from './providerActionsV1.js';
import { TeamCredentialProviderModelCatalogEntryV1Schema } from '../teams/credentials/resourceV1.js';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from './connections/connectionRowsV1.js';
import type { ProviderConnectionsCatalogSnapshotV1 } from './connections/connectionRowsV1.js';

const agentTargetKey = 'agent:happier.agent.codex/codex';
const teamCredentialModel = TeamCredentialProviderModelCatalogEntryV1Schema.parse({
  selection: { kind: 'team_credential_provider_model', resourceId: 'resource-a', teamId: 'team-a',
    expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey, modelId: 'model-a' },
  descriptor: { id: 'model-a', name: 'Model A' },
  application: { agentTargetKey, implementationIdentity: { pluginId: 'acme.gateway', localId: 'gateway' },
    endpointTemplateId: 'responses', protocol: 'openai-responses' },
  confirmationSource: { connectionId: 'connected-source:recipient', catalogSourceKey: 's'.repeat(43) },
  sourceRevision: 'source-a', availability: 'available',
});

describe('shared Provider Action recipient catalog admission', () => {
  it.each(['providers.models.projection', 'providers.models.refresh'] as const)(
    'refuses unavailable recipient consent through %s', async actionId => {
      const execute = createProviderActionExecuteV1({
        assertCurrent: () => {},
        rpc: async () => ({ status: 'success', agentTargetKey, groups: [] }),
        readAccountCatalog: async () => ({ status: 'unavailable', reason: 'authority-not-confirmed' }),
        setDefault: async () => ({ status: 'unchanged' }),
      });
      expect(await execute(parseProviderActionRequestV1(actionId, {
        machineId: 'machine-a', agentTargetKey, teamCredentialModel,
        ...(actionId === 'providers.models.refresh' ? { forceRefresh: true } : {}),
      }), {})).toMatchObject({ ok: true, result: { status: 'error', error: { code: 'provider_settings_invalid' } } });
    },
  );

  it.each(['cancelled', 'retired'] as const)('does not disclose a projection %s during the Account read', async scenario => {
    const controller = new AbortController();
    let current = true;
    const execute = createProviderActionExecuteV1({
      assertCurrent: context => {
        context.signal?.throwIfAborted();
        if (!current) throw Object.assign(new Error('Account retired'), { code: 'scope-retired' });
      },
      rpc: async () => ({ status: 'success', agentTargetKey, groups: [] }),
      readAccountCatalog: async (): Promise<ProviderConnectionsCatalogSnapshotV1> => {
        if (scenario === 'cancelled') controller.abort();
        else current = false;
        return { status: 'ready', revision: 1, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 };
      },
      setDefault: async () => ({ status: 'unchanged' }),
    });
    await expect(execute(parseProviderActionRequestV1('providers.models.projection', {
      machineId: 'machine-a', agentTargetKey, teamCredentialModel,
    }), { signal: controller.signal })).rejects.toMatchObject(scenario === 'cancelled'
      ? { name: 'AbortError' } : { code: 'scope-retired' });
  });
});
