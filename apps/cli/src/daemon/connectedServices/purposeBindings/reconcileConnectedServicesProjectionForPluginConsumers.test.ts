import { describe, expect, it, vi } from 'vitest';

import { reconcileConnectedServicesProjectionForPluginConsumers } from './reconcileConnectedServicesProjectionForPluginConsumers';

describe('reconcileConnectedServicesProjectionForPluginConsumers', () => {
  it('delivers quota-only refresh demand without reconciling or invalidating external credential sources', async () => {
    let reconciliations = 0;
    let externalInvalidations = 0;
    let quotaNotifications = 0;
    for (let arrival = 0; arrival < 375; arrival++) {
      await reconcileConnectedServicesProjectionForPluginConsumers({
        notification: { quotaRefreshOnly: true, quotaRefreshRecordIds: ['usage-record'] },
        reconcile: async () => { reconciliations++; },
        invalidateConfiguredExternalSessionSources: () => { externalInvalidations++; },
        invalidateConnectedAccounts: () => { quotaNotifications++; },
      });
    }
    expect(reconciliations).toBe(0);
    expect(externalInvalidations).toBe(0);
    expect(quotaNotifications).toBe(375);
  });

  it('invalidates public Connected Accounts after successful sibling reconciliation', async () => {
    const reconcile = vi.fn(async () => undefined);
    const invalidateConfiguredExternalSessionSources = vi.fn();
    const invalidateConnectedAccounts = vi.fn();

    await expect(reconcileConnectedServicesProjectionForPluginConsumers({
      notification: { kind: 'changed' },
      reconcile,
      invalidateConfiguredExternalSessionSources,
      invalidateConnectedAccounts,
    })).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledWith({ kind: 'changed' });
    expect(invalidateConfiguredExternalSessionSources).toHaveBeenCalledOnce();
    expect(invalidateConnectedAccounts).toHaveBeenCalledOnce();
  });

  it('still invalidates public Connected Accounts when sibling reconciliation rejects', async () => {
    const failure = new Error('sibling reconciliation failed');
    const reconcile = vi.fn(async () => {
      throw failure;
    });
    const invalidateConfiguredExternalSessionSources = vi.fn();
    const invalidateConnectedAccounts = vi.fn();

    await expect(reconcileConnectedServicesProjectionForPluginConsumers({
      notification: { kind: 'changed' },
      reconcile,
      invalidateConfiguredExternalSessionSources,
      invalidateConnectedAccounts,
    })).rejects.toBe(failure);
    expect(invalidateConfiguredExternalSessionSources).toHaveBeenCalledOnce();
    expect(invalidateConnectedAccounts).toHaveBeenCalledOnce();
  });

  it('invalidates configured External Session sources before reconciling the same projection', async () => {
    const order: string[] = [];
    const reconcile = vi.fn(async () => {
      order.push('reconcile');
    });
    const invalidateConnectedAccounts = vi.fn(() => {
      order.push('accounts');
    });
    const invalidateConfiguredExternalSessionSources = vi.fn(() => {
      order.push('external-sources');
    });
    const input = {
      notification: { kind: 'changed' },
      reconcile,
      invalidateConnectedAccounts,
      invalidateConfiguredExternalSessionSources,
    };

    await expect(reconcileConnectedServicesProjectionForPluginConsumers(input))
      .resolves.toBeUndefined();
    expect(invalidateConfiguredExternalSessionSources).toHaveBeenCalledOnce();
    expect(order).toEqual(['external-sources', 'reconcile', 'accounts']);
  });

  it('keeps configured External Session sources invalidated when projection reconciliation rejects', async () => {
    const failure = new Error('sibling reconciliation failed');
    const reconcile = vi.fn(async () => {
      throw failure;
    });
    const invalidateConnectedAccounts = vi.fn();
    const invalidateConfiguredExternalSessionSources = vi.fn();
    const input = {
      notification: { kind: 'changed' },
      reconcile,
      invalidateConnectedAccounts,
      invalidateConfiguredExternalSessionSources,
    };

    await expect(reconcileConnectedServicesProjectionForPluginConsumers(input))
      .rejects.toBe(failure);
    expect(invalidateConfiguredExternalSessionSources).toHaveBeenCalledOnce();
    expect(invalidateConnectedAccounts).toHaveBeenCalledOnce();
  });
});
