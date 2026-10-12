import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, type ProviderConnectionsCatalogV1 } from '../../providers/connections/connectionRowsV1.js';
import { revokeMachineWithProviderCleanup } from './revokeWithProviderCleanup.js';

describe('machine Account removal', () => {
  it('revokes and removes only the target machine Provider state through one Account row CAS', async () => {
    const catalog: ProviderConnectionsCatalogV1 = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
      connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'plugin/gateway' },
        role: 'default', displayName: 'Gateway', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }],
      machineGrants: ['removed', 'kept'].map(machineId => ({ v: 1 as const, machineId, connectionId: 'pc_a',
        endpointSetFingerprint: 'endpoint-set:v1:a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1 })) };
    let written: ProviderConnectionsCatalogV1 | undefined;
    const outcome = await revokeMachineWithProviderCleanup('removed', {
      revoke: async () => ({ ok: true }),
      readCatalog: async () => ({ status: 'ready', catalog, revision: 4 }),
      writeCatalog: async next => { written = next.catalog; return { status: 'updated' }; },
    });
    expect(outcome).toEqual({ ok: true, machineAlreadyRevoked: false, providerCleanup: 'complete' });
    expect(written?.machineGrants.map(grant => grant.machineId)).toEqual(['kept']);
  });

  it('retains retryable cleanup debt after an acknowledged revoke and unknown row write', async () => {
    const catalog: ProviderConnectionsCatalogV1 = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
      connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'plugin/gateway' },
        role: 'default', displayName: 'Gateway', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }],
      machineGrants: [{ v: 1, machineId: 'removed', connectionId: 'pc_a', endpointSetFingerprint: 'endpoint-set:v1:a',
        connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1 }] };
    const outcome = await revokeMachineWithProviderCleanup('removed', {
      revoke: async () => ({ ok: true }),
      readCatalog: async () => ({ status: 'ready', catalog, revision: 4 }),
      writeCatalog: async () => { throw new Error('outcome_unknown'); },
    });
    expect(outcome).toMatchObject({ ok: false, machineRevoked: true, providerCleanup: 'pending', retryable: true });
  });
});
