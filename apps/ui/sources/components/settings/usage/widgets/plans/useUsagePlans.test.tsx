import { afterEach, expect, it } from 'vitest';
import * as React from 'react';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createDeferred, renderHook, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storage';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { useUsagePlans, useUsageSelectorMachineId } from './useUsagePlans';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import { act } from 'react-test-renderer';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { QualifiedConnectedServiceUsageSourceV4Schema, QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { applyConnectedMetadataCatalogSnapshot } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { ConnectedPresentationRecordV1Schema } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); clearMachineRequestReachabilityForTest(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; });

it('changes the Usage selector when request reachability changes without a machine heartbeat', async () => {
  const { id: serverId } = await upsertAndActivateServer({ serverUrl: 'https://usage-selector.test', name: 'Usage Home' });
  publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://usage-selector.test', generation: 0 });
  const machines = ['first', 'second'].map(id => createMachineFixture({ id, activeAt: Date.now() }));
  const scope = { serverId, accountId: 'selector-account' };
  storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }), machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
    machineListByServerId: { [serverId]: machines } });
  const hook = await renderHook(() => useUsageSelectorMachineId());
  expect(hook.getCurrent()).toBe('first');
  await act(async () => recordMachineRequestFailed({ ...scope, machineId: 'first' }));
  expect(hook.getCurrent()).toBe('second');
  await act(async () => recordMachineRequestSucceeded({ ...scope, machineId: 'first' }));
  expect(hook.getCurrent()).toBe('first');
});

it('refreshes the displayed Usage Resource and creates no independent quota polling demand', async () => {
  const features = createDeferred<Response>();
  const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
  const email = { service: { pluginId: 'acme.email', localId: 'email' }, accountId: 'mail' };
  const poolRef = { service: ref.service, groupId: 'studio' };
  const profile = AccountProfileSchema.parse({ id: 'plans-account', connectedAccountsV4: [
    { ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [],
      displayName: 'Studio account', providerIdentity: { email: 'ai3@happier.dev' } },
    { ref: email, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] },
  ], connectedAccountGroupsV4: [QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: poolRef,
    displayName: 'Studio pool', incarnation: 'studio:1', policy: { strategy: 'priority' }, generation: 1,
    runtimeStateRevision: 1, state: {}, members: [], activeConnectedAccountId: null, createdAt: 1, updatedAt: 1 })] });
  home = await serveAccountHomes({ homes: [{ key: 'plans', serverUrl: 'https://usage-plans.test', accountId: 'plans-account', profile }],
    route: request => request.path === '/v1/features' ? features.promise.then(response => response.clone()) : undefined });
  const featureResponse = () => Response.json(createRootLayoutFeaturesResponse({ features: {
      connectedServices: { enabled: true, quotas: { enabled: true } },
    }, capabilities: { connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 } } } }));
  const serverId = home.homes.plans!.id;
  publishAppliedActiveServerSnapshot({ serverId, serverUrl: home.homes.plans!.serverUrl, generation: 0 });
  const scope = { serverId, accountId: 'plans-account' };
  storage.setState({ profileScope: scope, settingsScope: scope, profile });
  const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.plans!.serverUrl))!;
  const source = QualifiedConnectedServiceUsageSourceV4Schema.parse({ bindingKind: 'account', ref });
  let slice = resolveUsagePageAggregation({ queries: [normalizeUsageQuery({})], pools: [{ query: normalizeUsageQuery({}),
    value: [{ group: poolRef, memberAccountIds: ['work'], activeAccountId: null, selection: { status: 'pending' } }] }], sources: [
    { source: `quota:${JSON.stringify(source)}`, status: 'pending' },
    { source: `quota:${JSON.stringify({ bindingKind: 'account', ref: email })}`, status: 'pending' },
  ] }).results[0]!;
  let refreshed = false;
  const model = { refreshing: false, refresh: async () => { refreshed = true; } };
  const hook = await renderHook(() => useUsagePlans(slice, model), {
    wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children }),
  });
  try {
    const cold = hook.getCurrent();
    expect.soft(cold.nameOf(cold.projection.accounts[0]!).title).toBe('Studio account');
    expect.soft(cold.projection.pools[0]).toMatchObject({ name: 'Studio pool' });
    expect(cold.nameOf(cold.projection.accounts[1]!).serviceLabel).toBe(t('connectedServices.fallbackName'));
    await act(async () => installConnectedAccountDescriptorProjection({ scopeKey: 'plans', status: 'ready', conflicts: [], errorReason: null,
      descriptors: [{ id: 'email', serviceId: 'email', pluginId: 'acme.email', title: 'Email IMAP + SMTP', provenance: 'external',
        sourceKind: 'installed', authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual',
          outcomeReconciliation: 'none', fields: [] }] }, capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }] },
    captureActiveServerAccountScopeLifetime()!));
    await hook.rerender();
    expect(hook.getCurrent().nameOf(hook.getCurrent().projection.accounts[1]!).serviceLabel).toBe(t('connectedServices.fallbackName'));
    expect(hook.getCurrent().projection.pools[0]).toMatchObject({ name: 'Studio pool' });
    // Once the account's read answers, the already-hydrated service title can be shown.
    slice = { ...slice, sources: slice.sources.map(state => state.source === `quota:${JSON.stringify({ bindingKind: 'account', ref: email })}`
      ? { ...state, status: 'partial' } : state) };
    await hook.rerender();
    expect(hook.getCurrent().nameOf(hook.getCurrent().projection.accounts[1]!).serviceLabel).toBe('Email IMAP + SMTP');
    await hook.unmount();
    // Email can answer without an allowance observation. Its named presentation
    // still belongs to this Account when a different route starts a new batch.
    slice = { ...slice, sources: slice.sources.map(state => ({ ...state, status: 'pending' })) };
    const warm = await renderHook(() => useUsagePlans(slice, model), {
      wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children }),
    });
    expect(warm.getCurrent().nameOf(warm.getCurrent().projection.accounts[1]!).serviceLabel).toBe('Email IMAP + SMTP');
    expect(warm.getCurrent().projection.pools[0]).toMatchObject({ name: 'Studio pool' });
    await act(async () => {
      const presentation = ConnectedPresentationRecordV1Schema.parse({ v: 1, entries: [
        { v: 1, subject: { kind: 'account', account: ref }, label: 'Work subscription' },
      ] });
      applyConnectedMetadataCatalogSnapshot(scope, {
        presentation: { status: 'ready', revision: 1, entries: presentation.entries, diagnostics: [] },
        acknowledgements: { status: 'ready', revision: 1, entries: [], diagnostics: [] }, disclosure: [],
      }, true);
    });
    expect.soft(warm.getCurrent().nameOf(warm.getCurrent().projection.accounts[0]!).title).toBe('Work subscription');
    await act(async () => { features.resolve(featureResponse()); await getServerFeaturesSnapshot({ serverId }); });
    await flushHookEffects({ cycles: 20 });
    const projected = warm.getCurrent();
    expect(projected.nameOf(projected.projection.accounts[0]!).title).toBe('Work subscription');
    expect(home.requests.filter(request => request.path.includes('/quotas') || request.path.includes('/provider-account-usage'))).toEqual([]);
    await warm.getCurrent().refresh();
    expect(refreshed).toBe(true);
    slice = { ...slice, sources: slice.sources.map(state => ({ ...state, status: 'partial' })) };
    await act(async () => installConnectedAccountDescriptorProjection({ scopeKey: 'plans-refresh', status: 'ready', conflicts: [],
      errorReason: null, descriptors: [] }, captureActiveServerAccountScopeLifetime()!));
    await warm.rerender();
    expect(warm.getCurrent().nameOf(warm.getCurrent().projection.accounts[1]!).serviceLabel).toBe('Email IMAP + SMTP');
    await warm.unmount();
    retireActiveServerAccountScopeLifetime();
    slice = { ...slice, sources: slice.sources.map(state => ({ ...state, status: 'pending' })) };
    const retired = await renderHook(() => useUsagePlans(slice, model), {
      wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children }),
    });
    expect(retired.getCurrent().nameOf(retired.getCurrent().projection.accounts[1]!).serviceLabel).toBe(t('connectedServices.fallbackName'));
  } finally { features.resolve(featureResponse()); }
});
