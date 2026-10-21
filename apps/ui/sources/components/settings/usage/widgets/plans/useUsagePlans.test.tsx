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
import { useUsagePlans, useUsagePoolSelections, useUsageSelectorMachineId } from './useUsagePlans';
import { ConnectedServicePoolSelectionGetResponseV1Schema } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
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

it('retains the answered pool order during refresh and failed reads, but not after selector identity or authority changes', async () => {
  home = await serveAccountHomes({ homes: [{ key: 'order', serverUrl: 'https://usage-order.test', accountId: 'order-account' }],
    route: () => undefined });
  const server = home.homes.order!;
  publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
  const scope = { serverId: server.id, accountId: 'order-account' };
  storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }) });
  const group = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'pool' };
  const answer = (observedAtMs: number) => {
    const response = ConnectedServicePoolSelectionGetResponseV1Schema.parse({ group, observedAtMs,
    selection: { selected: null, reason: 'manual_strategy', excluded: [], decisionTrace: {
      activeProfileId: null, reason: 'manual_strategy', strategy: 'manual', selectionBasis: 'manual_strategy',
      sticky: false, orderedEligibleCandidates: [], candidates: [],
    } } });
    if ('status' in response) throw new Error('Expected a selector answer');
    return response;
  };
  const query = normalizeUsageQuery({});
  const pool = { group, memberAccountIds: ['work'], activeAccountId: null,
    selection: { status: 'error' as const, machineId: 'machine', errorCode: 'MACHINE_RPC_TIMEOUT' } };
  // The hook projects the Resource's admitted slice; retaining an answered pool order across a
  // refresh, a failed read or a re-batch is the aggregation's (`previous`), so the slices come from it.
  type Selection = NonNullable<ReturnType<typeof resolveUsagePageAggregation>['results'][number]['pools']>[number]['selection'];
  let aggregation: ReturnType<typeof resolveUsagePageAggregation> | undefined;
  const aggregate = (selection: Selection, members = ['work'], previous: typeof aggregation | null = aggregation) => {
    aggregation = resolveUsagePageAggregation({ queries: [query],
      pools: [{ query, value: [{ ...pool, memberAccountIds: members, selection }] }], previous: previous ?? undefined });
    return aggregation.results[0]!;
  };
  let slice = aggregate(pool.selection, ['work'], null);
  let hook = await renderHook(() => useUsagePoolSelections(slice));
  const key = `${group.service.pluginId}/${group.service.localId}:${group.groupId}`;
  const update = async (selection: Selection, members = ['work']) => {
    slice = aggregate(selection, members);
    await hook.rerender();
  };
  expect(hook.getCurrent().get(key)).toBe('failed');
  await update({ status: 'available', machineId: 'machine', value: answer(1) });
  expect(hook.getCurrent().get(key)).toMatchObject({ observedAtMs: 1 });
  expect(hook.getCurrent().get(key)).not.toHaveProperty('refreshError');
  expect.soft(hook.getCurrent().get(key)).toMatchObject({ memberStatus: 'none_known' });
  const excluded = answer(1);
  excluded.selection.excluded = [{ profileId: 'work', reason: 'disabled' }];
  await update({ status: 'available', machineId: 'machine', value: excluded });
  expect.soft(hook.getCurrent().get(key)).toMatchObject({ memberStatus: 'all_excluded' });
  const manual = answer(1);
  manual.selection.decisionTrace.candidates = [{ profileId: 'work', decision: 'eligible', quotaEvidence: { status: 'stale_or_missing' } }];
  await update({ status: 'available', machineId: 'machine', value: manual });
  expect.soft(hook.getCurrent().get(key)).toMatchObject({ memberStatus: 'known' });
  await update({ status: 'available', machineId: 'machine', value: answer(1) });
  await update({ status: 'pending', machineId: 'machine' });
  expect.soft(hook.getCurrent().get(key)).toMatchObject({ observedAtMs: 1 });
  expect.soft(hook.getCurrent().get(key)).toMatchObject({ memberStatus: 'none_known' });
  expect.soft(hook.getCurrent().get(key)).not.toHaveProperty('refreshError');
  await update({ status: 'error', machineId: 'machine', errorCode: 'connected_service_request_failed' });
  expect.soft(hook.getCurrent().get(key)).toMatchObject({ observedAtMs: 1, refreshError: 'failed' });
  await update({ status: 'available', machineId: 'machine', value: answer(2) });
  expect(hook.getCurrent().get(key)).toMatchObject({ observedAtMs: 2 });
  expect(hook.getCurrent().get(key)).not.toHaveProperty('refreshError');
  await update({ status: 'unsupported', errorCode: 'no_machine' });
  expect(hook.getCurrent().get(key)).toMatchObject({ observedAtMs: 2, refreshError: 'no_machine' });
  await update({ status: 'available', machineId: 'machine', value: answer(2) });
  await hook.unmount();
  // A newly mounted reader of the same Resource sees the retained answer too.
  const warmSlice = resolveUsagePageAggregation({ queries: [query], previous: aggregation,
    pools: [{ query, value: [{ ...pool, selection: { status: 'pending', machineId: 'machine' } }] }] }).results[0]!;
  const warm = await renderHook(() => useUsagePoolSelections(warmSlice));
  expect.soft(warm.getCurrent().get(key)).toMatchObject({ observedAtMs: 2 });
  await warm.unmount();
  hook = await renderHook(() => useUsagePoolSelections(slice));
  await update({ status: 'pending', machineId: 'other-machine' });
  expect(hook.getCurrent().get(key)).toBe('loading');
  await update({ status: 'available', machineId: 'machine', value: answer(2) });
  await update({ status: 'pending', machineId: 'machine' }, ['other-account']);
  expect(hook.getCurrent().get(key)).toBe('loading');
  await update({ status: 'available', machineId: 'machine', value: answer(2) });
  await update({ status: 'error', machineId: 'machine', errorCode: 'denied' });
  expect(hook.getCurrent().get(key)).toBe('failed');
  await update({ status: 'pending', machineId: 'machine' });
  expect(hook.getCurrent().get(key)).toBe('loading');
  await update({ status: 'available', machineId: 'machine', value: answer(3) });
  await update({ status: 'unsupported', machineId: 'machine', errorCode: 'unsupported' });
  await update({ status: 'pending', machineId: 'machine' });
  expect(hook.getCurrent().get(key)).toBe('loading');
  await update({ status: 'available', machineId: 'machine', value: answer(4) });
  // A Resource opened for another authority starts without the retired one's answer.
  slice = aggregate({ status: 'pending', machineId: 'machine' }, ['work'], null);
  await hook.rerender();
  expect(hook.getCurrent().get(key)).toBe('loading');
});

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
    expect(cold.projection.accounts.map(account => account.accountId)).toEqual(['work']);
    await act(async () => installConnectedAccountDescriptorProjection({ scopeKey: 'plans', status: 'ready', conflicts: [], errorReason: null,
      descriptors: [{ id: 'email', serviceId: 'email', pluginId: 'acme.email', title: 'Email IMAP + SMTP', provenance: 'external',
        sourceKind: 'installed', authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual',
          outcomeReconciliation: 'none', fields: [] }] }, capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }] },
    captureActiveServerAccountScopeLifetime()!));
    await hook.rerender();
    expect(hook.getCurrent().projection.accounts.map(account => account.accountId)).toEqual(['work']);
    expect(hook.getCurrent().projection.pools[0]).toMatchObject({ name: 'Studio pool' });
    // An unavailable catalog must not admit an ineligible service.
    await act(async () => installConnectedAccountDescriptorProjection({ scopeKey: 'plans-offline', status: 'loading',
      conflicts: [], errorReason: null, descriptors: [] }, captureActiveServerAccountScopeLifetime()!));
    const offline = await renderHook(() => useUsagePlans(slice, model), {
      wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children }),
    });
    expect.soft(offline.getCurrent().projection.accounts.map(account => account.accountId)).toEqual(['work']);
    await offline.unmount();
    await act(async () => installConnectedAccountDescriptorProjection({ scopeKey: 'plans', status: 'ready', conflicts: [], errorReason: null,
      descriptors: [{ id: 'email', serviceId: 'email', pluginId: 'acme.email', title: 'Email IMAP + SMTP', provenance: 'external',
        sourceKind: 'installed', authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual',
          outcomeReconciliation: 'none', fields: [] }] }, capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }] },
    captureActiveServerAccountScopeLifetime()!));
    // A source response does not grant a service the Usage capability.
    slice = { ...slice, sources: slice.sources.map(state => state.source === `quota:${JSON.stringify({ bindingKind: 'account', ref: email })}`
      ? { ...state, status: 'partial' } : state) };
    await hook.rerender();
    expect(hook.getCurrent().projection.accounts.map(account => account.accountId)).toEqual(['work']);
    await hook.unmount();
    // Starting a new batch must not turn a named Email account into Usage evidence.
    slice = { ...slice, sources: slice.sources.map(state => ({ ...state, status: 'pending' })) };
    const warm = await renderHook(() => useUsagePlans(slice, model), {
      wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children }),
    });
    expect(warm.getCurrent().projection.accounts.map(account => account.accountId)).toEqual(['work']);
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
    expect(warm.getCurrent().projection.accounts.map(account => account.accountId)).toEqual(['work']);
    // A retained Resource snapshot can outlive the authoritative group definition.
    // A same-id group from another service must not keep the deleted pool alive.
    await act(async () => storage.setState({ profile: { ...profile, connectedAccountGroupsV4: [
      { ...profile.connectedAccountGroupsV4[0]!, ref: { service: email.service, groupId: poolRef.groupId } },
    ] } }));
    expect.soft(warm.getCurrent().projection.pools).toEqual([]);
    await act(async () => storage.setState({ profile }));
    expect(warm.getCurrent().projection.pools[0]).toMatchObject({ name: 'Studio pool' });
    await warm.unmount();
    retireActiveServerAccountScopeLifetime();
    slice = { ...slice, sources: slice.sources.map(state => ({ ...state, status: 'pending' })) };
    const retired = await renderHook(() => useUsagePlans(slice, model), {
      wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children }),
    });
    expect(retired.getCurrent().projection.accounts.map(account => account.accountId)).toEqual(['work']);
  } finally { features.resolve(featureResponse()); }
});
