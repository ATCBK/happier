import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceCurrentSourceHydrationConflictError, hydrateProviderAccountUsageStoreFromConnectedServiceInventory } from './currentSourceHydration';
import { createProviderAccountUsageStore } from './store';
import { activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration } from './startupActivation';

describe('provider-account usage startup activation', () => {
  it('constructs and starts quota policy only after readiness and hydration', async () => {
    const order: string[] = [];
    const coordinator = { scheduleCurrentSourceRefresh: vi.fn(() => order.push('schedule')) };
    const result = await activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      enabled: true,
      quotaFetchers: [{ serviceId: 'openai-codex' }, { serviceId: 'openai-codex' }],
      awaitReadiness: async () => { order.push('ready'); },
      hydrate: async ({ serviceIds }) => {
        order.push(`hydrate:${serviceIds.join(',')}`);
        return { refreshSources: [] };
      },
      createCoordinator: () => { order.push('create'); return coordinator; },
      startLoop: () => { order.push('loop'); return { stop: vi.fn() }; },
      onActivationError: vi.fn(),
    });
    expect(result.status).toBe('active');
    expect(order).toEqual(['ready', 'hydrate:openai-codex', 'create', 'schedule', 'loop']);
  });

  it('fails closed without constructing quota policy when hydration fails', async () => {
    const createCoordinator = vi.fn(() => ({ scheduleCurrentSourceRefresh: vi.fn() }));
    const startLoop = vi.fn();
    await expect(activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      enabled: true,
      quotaFetchers: [{ serviceId: 'openai-codex' }],
      awaitReadiness: async () => {},
      hydrate: async () => { throw new Error('hydration failed'); },
      createCoordinator,
      startLoop,
      onActivationError: vi.fn(),
    })).resolves.toMatchObject({ status: 'quota_policy_disabled' });
    expect(createCoordinator).not.toHaveBeenCalled();
    expect(startLoop).not.toHaveBeenCalled();
  });

  it('retries a bounded transient inventory conflict before activating quota policy', async () => {
    const hydrate = vi.fn()
      .mockRejectedValueOnce(new ConnectedServiceCurrentSourceHydrationConflictError('source changed'))
      .mockRejectedValueOnce(new ConnectedServiceCurrentSourceHydrationConflictError('inventory changed'))
      .mockResolvedValue({ refreshSources: [] });
    const createCoordinator = vi.fn(() => ({ scheduleCurrentSourceRefresh: vi.fn() }));

    await expect(activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      enabled: true,
      quotaFetchers: [{ serviceId: 'openai-codex' }],
      awaitReadiness: async () => {},
      hydrate,
      createCoordinator,
      startLoop: () => ({ stop: vi.fn() }),
      onActivationError: vi.fn(),
    })).resolves.toMatchObject({ status: 'active' });

    expect(hydrate).toHaveBeenCalledTimes(3);
    expect(createCoordinator).toHaveBeenCalledTimes(1);
  });

  it('stops transient-conflict hydration when its daemon lifecycle retires', async () => {
    const error = new ConnectedServiceCurrentSourceHydrationConflictError('source keeps changing');
    let current = true;
    const hydrate = async () => { current = false; throw error; };
    const createCoordinator = vi.fn(() => ({ scheduleCurrentSourceRefresh: vi.fn() }));
    const onActivationError = vi.fn();

    await expect(activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      enabled: true,
      isCurrent: () => current,
      quotaFetchers: [{ serviceId: 'openai-codex' }],
      awaitReadiness: async () => {},
      hydrate,
      createCoordinator,
      startLoop: () => ({ stop: vi.fn() }),
      onActivationError,
    })).resolves.toMatchObject({ status: 'quota_policy_disabled', error: { code: 'daemon_shutting_down' } });

    expect(createCoordinator).not.toHaveBeenCalled();
    expect(onActivationError).toHaveBeenCalledWith(expect.objectContaining({ code: 'daemon_shutting_down' }));
  });

  it('activates after repeated real inventory conflicts settle beyond the previous retry cutoff', async () => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    let inventories = 0;
    const result = await activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      enabled: true,
      quotaFetchers: [{ serviceId: 'openai-codex' }],
      awaitReadiness: async () => {},
      hydrate: async ({ serviceIds }) => (await hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
        serviceIds, credentials: { token: 'token', encryption: null }, store: createProviderAccountUsageStore(), nowMs: 1_000,
        api: {
          getAccountEncryptionMode: async () => 'plain',
          listAccounts: async () => ({ service, accounts: ++inventories <= 12 && inventories % 2 === 1 ? [{
            ref: { service, accountId: 'work' }, status: 'connected', authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            configurationReady: true, configurationRevision: 'cfg-current', kind: 'oauth', expiresAt: null,
            providerIdentity: { accountId: 'acct-work' }, displayName: 'Work', scopes: [],
          }] : [] }),
          listGroups: async () => ({ groups: [] }),
          resolveSource: async () => null,
          readProviderAccountUsageRecord: async () => null,
        },
      })).hydration,
      createCoordinator: () => ({ scheduleCurrentSourceRefresh: () => {} }),
      startLoop: () => ({ stop: () => {} }),
      onActivationError: () => {},
    });
    expect(result.status).toBe('active');
  });

  it('does not retry non-conflict hydration failures', async () => {
    const error = new Error('hydration failed');
    const hydrate = vi.fn().mockRejectedValue(error);

    await expect(activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      enabled: true,
      quotaFetchers: [{ serviceId: 'openai-codex' }],
      awaitReadiness: async () => {},
      hydrate,
      createCoordinator: () => ({ scheduleCurrentSourceRefresh: vi.fn() }),
      startLoop: vi.fn(),
      onActivationError: vi.fn(),
    })).resolves.toEqual({ status: 'quota_policy_disabled', error });

    expect(hydrate).toHaveBeenCalledTimes(1);
  });
});
