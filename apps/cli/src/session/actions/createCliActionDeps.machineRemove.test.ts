import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema,
  ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it('removes a machine through the Account Action with the same Provider cleanup as the UI', async () => {
  const credentials = { token: 'machine-removal-owner', encryption: null };
  const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 4,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) };
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    serverHttpBaseUrl: 'https://machine-home.invalid', isCurrent: async () => true });
  let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'plugin/gateway' },
      role: 'default', displayName: 'Gateway', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }],
    machineGrants: ['removed', 'kept'].map(machineId => ({ v: 1, machineId, connectionId: 'pc_a',
      endpointSetFingerprint: 'endpoint-set:v1:a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1 })) });
  const effects: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 4, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
      status: 'present', revision: effects.length + 1, content: { t: 'plain', v: catalog } } };
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/machines/removed/revoke') { effects.push('revoke'); return { status: 200, data: {} }; }
    if (path === '/v1/account/entity-rows/provider-connections') {
      effects.push('catalog');
      const mutation = ProviderConnectionsRowMutationV1Schema.parse(body);
      if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Provider row');
      catalog = mutation.content.v;
      return { status: 200, data: { status: 'updated', revision: 2, cursor: 1 } };
    }
    throw new Error(`Unexpected POST ${path}`);
  });
  const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', serverId: 'home',
    serverHttpBaseUrl: 'https://machine-home.invalid', mode: 'plain', ctx: null, savedSecretOperationContext: operationContext });
  const outcome = await deps.machinePageAction!({ actionId: 'machines.remove', input: { machineId: 'removed' },
    context: { surface: 'cli', authority: 'present_user' } });
  expect(outcome).toEqual({ ok: true, machineAlreadyRevoked: false, providerCleanup: 'complete' });
  expect(effects).toEqual(['revoke', 'catalog']);
  expect(catalog.machineGrants.map(grant => grant.machineId)).toEqual(['kept']);
});
