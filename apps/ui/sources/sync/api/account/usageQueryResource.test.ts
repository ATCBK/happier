import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageWorkEvidence } from '@happier-dev/protocol/usage/usageOutcomeAllocation';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore, readUiUsageQueryBatch } from './usageQueryResource';
import { storage } from '@/sync/domains/state/storage';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
// These source-adapter tests do not register unrelated Settings surfaces.
// Keep the canonical helpers without the presentation harness barrel graph.
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { QualifiedConnectedAccountQuotaResponseV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedProviderAccountUsageHistoryRequestV4Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { parseQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { buildProviderAccountUsageScopeKey } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageLoadRoute';
import { getProviderAccountUsageCacheState, updateProviderAccountUsageCacheEntries } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageCache';
import { getProviderAccountUsageSnapshotPlain } from './apiProviderAccountUsage';
import { buildQualifiedQuotaSnapshotScopeKey, getQualifiedQuotaSnapshotEntry, loadQualifiedQuotaSnapshotOnce, reloadQualifiedQuotaSnapshotAfterRecovery,
  subscribeQualifiedQuotaSnapshotEntry } from '@/hooks/server/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { settingsParse } from '@/sync/domains/settings/settings';
import * as React from 'react';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { useProviderAccountUsageSnapshots } from '@/hooks/server/connectedServices/useProviderAccountUsageSnapshots';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { UsageWidgetBodyModel } from '@/components/settings/usage/useUsageWidgetResource';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { act } from 'react-test-renderer';
import * as platformDigest from '@/platform/digest';
import { projectUsagePlans } from '@/components/settings/usage/widgets/plans/usagePlansModel';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';

const scmTransport = vi.hoisted(() => vi.fn());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
  const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
  return createServerScopedMachineRpcBoundaryMock(scmTransport);
});

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); clearMachineRequestReachabilityForTest(); await home?.dispose(); home = undefined;
  // Digest and clock spies are system boundaries scoped to one case; leaving
  // them installed changes later Resource progress and timing observations.
  vi.restoreAllMocks();
});

const value: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
  cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };
const workContribution = { id: 'cost', observedAtMs: 500, sessionId: 'work-session', turnId: 'turn', agentId: null,
  modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null,
  tokens: value.totals.tokens, cost: value.totals.cost };

const ownerSessionAccess = {
  effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
    capabilities: createSessionAccessFixture().capabilities },
  responsibleAccountId: null, responsibleAccount: null,
};

async function context(route: Parameters<typeof serveAccountHomes>[0]['route']) {
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-batch.test', accountId: 'account-a' }],
    route: async request => {
      const response = await route(request);
      if (response) return response;
      // This harness supplies a plain Account token; storage reads also need
      // its canonical currentness response, not just the legacy mode route.
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      return undefined;
    } });
  publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
  const captured = captureUiUsageQueryAccountContext(credentials);
  if (!captured) throw new Error('Expected admitted fixture Account');
  // The HTTP harness admits a Home/Account; its UI Profile projection must
  // carry that same scope before an Account-owned Usage read can use it.
  storage.setState({ profileScope: captured.accountLifetime.scope,
    profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId }) });
  return captured;
}

describe('usage query captured Resource adapter', () => {
  it('settles accounting-only demand without private Session or SCM acquisition', async () => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json({ ...value,
      contributions: [workContribution] }) : undefined);
    storage.setState({ profileScope: captured.accountLifetime.scope,
      profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId }),
      sessions: { 'work-session': createSessionFixture({ id: 'work-session', serverId: captured.accountLifetime.scope.serverId }) } });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [
      normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeSessionEvidence: false, includeWorkEvidence: false }),
    ] }) });
    const release = entry.subscribe(() => {}, true);
    try {
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(entry.getSnapshot().error?.code).toBeUndefined();
      const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      expect(slice.accounting?.totals).toMatchObject(value.totals);
      expect(slice.sources).toContainEqual({ source: 'work', status: 'not_loaded' });
      expect(slice.sources).toContainEqual({ source: 'how_you_work', status: 'not_loaded' });
      expect(slice.pending).toBe(false);
      expect(home!.requests.filter(request => /\/sessions\//.test(request.path))).toEqual([]);
    } finally { release(); }
  });

  it('admits usage content only after the asynchronous platform digest completes', async () => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    storage.setState({ profileScope: captured.accountLifetime.scope,
      profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId }) });
    const digestGate = createDeferred<void>();
    const originalDigest = platformDigest.digest;
    const digest = vi.spyOn(platformDigest, 'digest').mockImplementation(async (algorithm, bytes) => {
      await digestGate.promise;
      return await originalDigest(algorithm, bytes);
    });
    const entry = getUsageQueryResourceStore(captured)
      .getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ period: { relative: '7days' } }] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await expect.poll(() => digest.mock.calls.length).toBeGreaterThan(0);
      expect(entry.getSnapshot().value).toBeUndefined();
      digestGate.resolve();
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(entry.getSnapshot().value).toBeDefined();
    } finally { digestGate.resolve(); release(); }
  });

  it('coalesces superseded progress while an asynchronous digest is pending', async () => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    storage.setState({ profileScope: captured.accountLifetime.scope,
      profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId }) });
    const digestGate = createDeferred<void>();
    const originalDigest = platformDigest.digest;
    const digest = vi.spyOn(platformDigest, 'digest').mockImplementation(async (algorithm, bytes) => {
      if (digest.mock.calls.length === 1) await digestGate.promise;
      return await originalDigest(algorithm, bytes);
    });
    const entry = getUsageQueryResourceStore(captured)
      .getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ period: { relative: '7days' } }] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await expect.poll(() => digest.mock.calls.length).toBe(1);
      await flushHookEffects();
      digestGate.resolve();
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(digest).toHaveBeenCalledTimes(2);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting).toMatchObject(value);
    } finally { digestGate.resolve(); release(); }
  });

  it('publishes last-known admitted allowances on first mount while all refresh transports are held', async () => {
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'retained-l3' };
    const source = { bindingKind: 'account' as const, ref };
    const now = Date.now();
    const recordKey = { providerId: 'codex', accountSubjectId: 'retained-l3', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'retained-l3' }, observedAtMs: now,
      fetchedAtMs: now, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'weekly', label: 'Weekly', used: null, limit: null, usedPct: 42, utilizationPct: 42,
        unit: 'count', status: 'ok', resetAtMs: now + 86_400_000, resetsAt: now + 86_400_000 }] });
    const resolution = { source, recordId: snapshot.recordId, providerAccountId: 'retained-l3', fetchedAt: now, staleAfterMs: 60_000 };
    const gate = createDeferred<void>();
    let hold = false;
    const captured = await context(async request => {
      if (hold && request.path !== '/v1/features') await gate.promise;
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v4/connect/qualified/quotas') return Response.json({ ref, sourceResolution: resolution,
        content: { t: 'plain', v: { v: 1, ref, activeAccountId: 'retained-l3', fetchedAt: now, staleAfterMs: 60_000,
          planLabel: null, accountLabel: null, meters: [] } }, metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' } });
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json(resolution);
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({ content: { t: 'plain', v: snapshot },
        metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [source] });
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') return Response.json({ entries: [], nextCursor: null });
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId,
      connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] }) });
    const basis = getActiveServerSnapshot();
    await getServerFeaturesSnapshot({ serverId: basis.serverId, force: true });
    const readContext = { credentials: captured.credentials, ref,
      credentialScope: [captured.accountLifetime.scope.serverId, String(basis.generation), resolveAuthCredentialsScopeKey(captured.credentials)].join('\u0000'),
      serverBasis: { serverId: captured.accountLifetime.scope.serverId, generation: basis.generation },
      assertOperationAllowed: async () => { throw new Error('Passive read must not refresh a provider'); } };
    const key = buildQualifiedQuotaSnapshotScopeKey(readContext);
    loadQualifiedQuotaSnapshotOnce(key, readContext);
    await expect.poll(() => getQualifiedQuotaSnapshotEntry(key).usageRecordId).toBe(snapshot.recordId);
    const opened = await getProviderAccountUsageSnapshotPlain(captured.credentials, { recordId: snapshot.recordId }, { expectedActiveServer: readContext.serverBasis });
    const providerScope = buildProviderAccountUsageScopeKey({ serverId: captured.accountLifetime.scope.serverId,
      generation: basis.generation, credentialScope: resolveAuthCredentialsScopeKey(captured.credentials) });
    updateProviderAccountUsageCacheEntries(providerScope, () => ({ [snapshot.recordId]: {
      snapshot: opened, loading: true, hadError: false, nextFetchAtMs: now, consecutiveErrors: 0 } }));
    hold = true;
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ period: { relative: '7days' } }] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await expect.poll(() => {
        const content = entry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results[0]?.quota?.[0]?.current;
      }).toEqual(snapshot);
      expect(entry.getSnapshot().pending).toBe('initial');
    } finally { gate.resolve(); release(); }
  });

  it.each([
    { status: null, expected: { status: 'unsupported', errorCode: 'no_connected_accounts' } },
    { status: 'needs_reauth' as const, expected: { status: 'error', errorCode: 'connected_account_needs_reauth' } },
  ])('settles allowance reads without eligible accounts ($status)', async ({ status, expected }) => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    storage.setState({ profileScope: captured.accountLifetime.scope,
      profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId,
        connectedAccountsV4: status ? [{ ref: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
          accountId: 'reauth-account' }, status, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
          credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] : [] }) });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ period: { relative: '7days' } }] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      expect(slice.sources).toContainEqual(expect.objectContaining({ source: 'quota', ...expected }));
      expect(slice.pending).toBe(false);
      expect(home!.requests.some(request => request.path.includes('/provider-account-usage/'))).toBe(false);
    } finally { release(); }
  });
  it('adds opened machine locations to source coverage without sending names or private paths to accounting', async () => {
    const observed: UsageAnalyticsQueryResponse = { ...value, coverage: { status: 'partial', reasons: [], missingDimensions: [],
      range: { complete: false }, ranked: [], sources: [{ source: 'native-history', path: 'native', status: 'available',
        eventCount: 1, machineId: 'work-machine', captureKind: 'from_logs' }] } };
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(observed) : undefined);
    storage.setState({ profileScope: captured.accountLifetime.scope,
      profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId }) });
    const machine = createMachineFixture({ id: 'work-machine' });
    storage.getState().applyMachines([{ ...machine, metadata: { ...machine.metadata!, displayName: 'Workstation',
      host: 'private-host', homeDir: '/private/home', happyHomeDir: '/private/logs' } }]);
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } });
    const first = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(first.results[0]?.accounting?.coverage?.sources[0]).toMatchObject({ machineId: 'work-machine',
      captureKind: 'from_logs', displayLocation: 'Workstation' });
    expect(JSON.stringify(first)).not.toContain('/private/');
    expect(JSON.stringify(home!.requests)).not.toContain('Workstation');
    storage.getState().applyMachines([{ ...machine, availability: { kind: 'locked', reason: 'decryption_failed' }, metadata: null }]);
    const locked = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, first);
    expect(locked.results[0]?.accounting?.coverage?.sources[0]).not.toHaveProperty('displayLocation');
    storage.getState().applyMachines([{ ...machine, metadata: { ...machine.metadata!, displayName: 'Foreign workstation' } }]);
    storage.setState({ profileScope: { ...captured.accountLifetime.scope, accountId: 'other-account' } });
    await expect(readUiUsageQueryBatch(captured, { queries: [query] }, undefined, first))
      .rejects.toMatchObject({ code: 'stale_surface' });
  });
  it('shares admitted hypothetical selector reads and never relabels a live response as a future comparison', async () => {
    const captured = await context(() => undefined);
    const input = { machineId: 'selected', group: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'work' },
      hypothetical: { strategy: 'manual' as const, atMs: 300 } };
    const response = { group: input.group, observedAtMs: 100, hypothetical: input.hypothetical,
      selection: { selected: null, reason: 'manual_strategy', excluded: [], decisionTrace: { activeProfileId: 'work',
        reason: 'manual_strategy', strategy: 'manual', selectionBasis: 'manual_strategy', sticky: false,
        orderedEligibleCandidates: [], candidates: [] } } };
    let acknowledged = true;
    scmTransport.mockImplementation(async (request: { payload: unknown }) => {
      expect(request.payload).toEqual(input);
      if (acknowledged) return response;
      const { hypothetical: _hypothetical, ...live } = response;
      return live;
    });
    const store = getUsageQueryResourceStore(captured);
    const entry = store.getEntry({ hostRead: 'connectedServices.pools.selection.get', input });
    const release = entry.subscribe(() => {}, false);
    try {
      const snapshot = await entry.refresh();
      expect(snapshot.error).toBeFalsy();
      expect(JSON.parse(new TextDecoder().decode(snapshot.value!.bytes))).toEqual(response);
      expect(store.getEntry({ hostRead: 'connectedServices.pools.selection.get', input: {
        hypothetical: { atMs: 300, strategy: 'manual' }, group: input.group, machineId: 'selected' } }).getSnapshot()).toBe(entry.getSnapshot());
      expect(store.getEntry({ hostRead: 'connectedServices.pools.selection.get', input: {
        machineId: 'selected', group: input.group } }).getSnapshot()).not.toBe(entry.getSnapshot());
      acknowledged = false;
      const unacknowledged = await entry.refresh();
      expect(unacknowledged.error?.code).toBe('connected_account_daemon_response_invalid');
      // A retained authorized value still answers the old acknowledged scenario; no fresh live value replaces it.
      if (unacknowledged.value) expect(JSON.parse(new TextDecoder().decode(unacknowledged.value.bytes))).toEqual(response);
      retireActiveServerAccountScopeLifetime();
      expect(entry.getSnapshot().value).toBeUndefined();
    } finally { release(); }
  });
  it('re-prices retained history when captured Account price settings change without altering reported costs', async () => {
    const tokens = { input: 1_000_000, output: 500_000, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_500_000 };
    const cost = { reportedUsd: 7, estimatedUsd: 3, currency: 'USD' };
    const historical: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1, tokens, cost }, contributions: [
      { ...workContribution, id: 'price-history', sessionId: null, modelId: 'private-model', tokens, cost },
    ] };
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(historical) : undefined);
    const setPrice = (inputUsdPerMillion: number) => storage.setState({ settingsScope: captured.accountLifetime.scope,
      settings: settingsParse({ usageModelPriceOverridesV1: { 'private-model': { kind: 'rates', inputUsdPerMillion, outputUsdPerMillion: 4 } } }) });
    setPrice(2);
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    const read = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
    try {
      await entry.refresh();
      expect(read().costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(4);
      expect(read().accounting?.totals.cost).toMatchObject(cost);
      setPrice(6);
      await expect.poll(() => read().costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(8);
      expect(read().accounting?.contributions?.[0]?.cost).toMatchObject(cost);
      expect(home!.requests.filter(request => request.path === '/v2/usage/query').every(request =>
        !JSON.stringify(request.body).includes('usageModelPriceOverridesV1'))).toBe(true);
      storage.setState({ settingsScope: { serverId: 'foreign', accountId: 'other' },
        settings: settingsParse({ usageModelPriceOverridesV1: { 'private-model': { kind: 'rates', inputUsdPerMillion: 100, outputUsdPerMillion: 100 } } }) });
      await expect.poll(() => read().costFactTotals?.find(fact => fact.kind === 'unpriced')?.amountUsd).toBeNull();
      expect(read().costFactTotals?.find(fact => fact.kind === 'api_equivalent')).toBeUndefined();
    } finally { release(); }
  });
  it('shares qualified overlapping pools and selector revisions in the exact machine-scoped Resource', async () => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const group = (groupId: string, memberAccountIds: string[]) => ({ v: 1, ref: { service, groupId }, incarnation: 'incarnation',
      displayName: groupId, policy: { strategy: 'priority' }, activeConnectedAccountId: 'work', generation: 1,
      runtimeStateRevision: 1, state: {}, createdAt: 1, updatedAt: 1,
      members: memberAccountIds.map(connectedAccountId => ({ v: 1, connectedAccountId, priority: 1, enabled: true,
        state: {}, createdAt: 1, updatedAt: 1 })) });
    storage.setState({ profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId,
      connectedAccountsV4: ['work', 'personal', 'standalone'].map(accountId => ({ ref: { service, accountId }, status: 'connected',
        authenticationModeId: 'manual', revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
        configurationReady: false, configurationRevision: null, scopes: [] })),
      connectedAccountGroupsV4: [group('first', ['work', 'personal']), group('second', ['work'])] }),
      machines: { selected: createMachineFixture({ id: 'selected', activeAt: Date.now() }),
        other: createMachineFixture({ id: 'other', activeAt: Date.now() }) } });
    let selectedId = 'work';
    let denied = false;
    let unavailable = false;
    scmTransport.mockImplementation(async (input: { machineId: string; payload: { group: { service: typeof service; groupId: string } } }) => {
      if (denied) throw Object.assign(new Error('Denied'), { code: 'denied' });
      if (unavailable) return { status: 'unavailable', code: 'connected_account_daemon_runtime_unavailable' };
      expect(input.machineId).toBe('selected');
      const selected = { profileId: selectedId, priority: 1, createdAtMs: 1, enabled: true, leastLimitedScore: 50 };
      return { group: input.payload.group, observedAtMs: 100, selection: { selected, reason: 'selected', excluded: [],
        decisionTrace: { activeProfileId: selectedId, reason: 'selected', strategy: 'priority', selectionBasis: 'active_stickiness',
          sticky: true, orderedEligibleCandidates: [selected], candidates: [] } } };
    });
    const query = normalizeUsageQuery({ machines: ['selected'] });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    try {
      await entry.refresh();
      const pools = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools;
      expect(pools).toMatchObject([{ group: { service, groupId: 'first' }, memberAccountIds: ['work', 'personal'],
        selection: { status: 'available', machineId: 'selected', value: { selection: { selected: { profileId: 'work' } } } } },
        { group: { service, groupId: 'second' }, memberAccountIds: ['work'] }]);
      selectedId = 'personal';
      publishHomeAccountChange(captured.accountLifetime.scope.serverId);
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools?.[0]?.selection.value)
        .toMatchObject({ selection: { selected: { profileId: 'personal' } } });
      denied = true;
      await entry.refresh();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools?.every(pool =>
        pool.selection.status === 'error' && pool.selection.value === undefined)).toBe(true);
      const ambiguous = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({})] });
      expect(ambiguous.results[0]?.pools?.every(pool => pool.selection.status === 'unknown' && pool.selection.machineId === undefined)).toBe(true);
      denied = false;
      recordMachineRequestFailed({ ...captured.accountLifetime.scope, machineId: 'selected' });
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools?.[0]?.selection)
        .toMatchObject({ status: 'unsupported', errorCode: 'no_machine' });
      recordMachineRequestSucceeded({ ...captured.accountLifetime.scope, machineId: 'selected' });
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools?.[0]?.selection.status).toBe('available');
      unavailable = true;
      const terminal = await readUiUsageQueryBatch(captured, { queries: [query] });
      expect(terminal.results[0]?.pools?.map(pool => pool.selection)).toEqual([
        expect.objectContaining({ status: 'error', errorCode: 'connected_account_daemon_runtime_unavailable' }),
        expect.objectContaining({ status: 'error', errorCode: expect.any(String) }),
      ]);
      storage.setState({ machines: { selected: createMachineFixture({ id: 'selected', activeAt: Date.now(), revokedAt: Date.now() }) } });
      const revoked = await readUiUsageQueryBatch(captured, { queries: [query] });
      expect(revoked.results[0]?.pools?.every(pool => pool.selection.status === 'unsupported'
        && pool.selection.errorCode === 'no_machine' && pool.selection.machineId === undefined)).toBe(true);
      storage.setState({ machines: { selected: createMachineFixture({ id: 'selected', activeAt: Date.now(), replacedByMachineId: 'new-machine' }) } });
      const replaced = await readUiUsageQueryBatch(captured, { queries: [query] });
      expect(replaced.results[0]?.pools?.every(pool => pool.selection.status === 'unsupported'
        && pool.selection.errorCode === 'no_machine' && pool.selection.machineId === undefined)).toBe(true);
    } finally { release(); }
  });

  it('publishes a ready current slice before a held comparison and distinct query', async () => {
    const held = createDeferred<Response>();
    const captured = await context(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
      return query.dateRange?.startMs === 1000 && query.filters?.agentIds?.includes('claude') ? Response.json(value) : held.promise.then(response => response.clone());
    });
    const current = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 }, agents: ['claude'] });
    const other = normalizeUsageQuery({ ...current, agents: ['codex'] });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [current, other] }) });
    const startedAt = performance.now();
    const release = entry.subscribe(() => {}, false);
    try {
      await expect.poll(() => {
        const content = entry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results.find(slice => slice.key === getUsageQueryKey(current))?.accounting;
      }).toMatchObject(value);
      const firstUsefulMs = performance.now() - startedAt;
      const batch = decodeUsageQueryResource(entry.getSnapshot().value!);
      expect(batch.results.find(slice => slice.key === getUsageQueryKey(current))?.comparison?.source.status).toBe('pending');
      expect(batch.results.find(slice => slice.key === getUsageQueryKey(other))).toMatchObject({ pending: true,
        sources: expect.arrayContaining([{ source: 'accounting', status: 'pending' }]) });
      expect(batch.results.find(slice => slice.key === getUsageQueryKey(other))?.accounting).toBeUndefined();
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results
        .find(slice => slice.key === getUsageQueryKey(current))?.sources.find(source => source.source === 'work')?.status).toBe('unknown');
      held.resolve(Response.json(value));
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      const settledMs = performance.now() - startedAt;
      expect(firstUsefulMs).toBeLessThan(settledMs);
      console.info(`Usage held-source timing: first useful ${firstUsefulMs.toFixed(1)}ms; settled ${settledMs.toFixed(1)}ms`);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results.every(slice => slice.accounting !== undefined)).toBe(true);
    } finally { held.resolve(Response.json(value)); release(); }
  });

  it.each([true, false])('rejects late private evidence on Account retirement for explicit Session selection %s', async explicit => {
    let response: UsageAnalyticsQueryResponse = { ...value, contributions: [workContribution] };
    let held = false;
    const work = createDeferred<unknown>();
    const privateSession = createDeferred<Response>();
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(response)
      : request.path === '/v2/sessions/work-session' ? held ? privateSession.promise : Response.json({ error: 'not_found' }, { status: 404 })
      : request.path === '/v1/account/encryption/currentness' ? Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }) : undefined);
    storage.getState().applySessions([createSessionFixture({ id: 'work-session', active: true,
      serverId: captured.accountLifetime.scope.serverId, metadata: { machineId: 'work-machine', path: '/repo', host: 'test', homeDir: '/home/test' } })]);
    storage.getState().applyMachines([createMachineFixture({ id: 'work-machine' })]);
    scmTransport.mockImplementation(() => held ? work.promise : Promise.resolve({ success: true, pullRequests: [] }));
    const query = normalizeUsageQuery({ ...(explicit ? { session: 'work-session' } : {}), period: { startMs: 0, endMs: 1000 } });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await entry.refresh();
      held = true;
      response = { ...response, totals: { ...value.totals, eventCount: 2 } };
      const refreshing = entry.refresh();
      await expect.poll(() => {
        const snapshot = entry.getSnapshot();
        expect(snapshot.error).toBeUndefined();
        const content = snapshot.value;
        return content && decodeUsageQueryResource(content).results[0]?.accounting?.totals.eventCount;
      }).toBe(2);
      expect(entry.getSnapshot().pending).toBe('refresh');
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual({ source: 'work', status: 'pending' });
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual({ source: 'how_you_work', status: 'pending' });
      retireActiveServerAccountScopeLifetime();
      work.resolve({ success: true, pullRequests: [] });
      privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
      await refreshing;
      await flushHookEffects();
      expect(entry.getSnapshot().value).toBeUndefined();
    } finally { work.resolve({ success: true, pullRequests: [] }); privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 })); release(); }
  });

  it('reads chosen Account night hours through the recorded activity query without inventing private busy duration', async () => {
    const accounting: UsageAnalyticsQueryResponse = { ...value, activity: {
      weekdayHourBuckets: [{ weekday: 5, hour: 0, eventCount: 7 }, { weekday: 5, hour: 12, eventCount: 3 }] } };
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined);
    storage.setState({ settings: settingsParse({ usageNightHoursV1: { startHour: 23, endHour: 7 } }), settingsScope: captured.accountLifetime.scope });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 86400000 }, timeZoneOffsetMinutes: 120 });
    const batch = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(batch.results[0]?.howYouWork?.nightShift).toEqual({ startHour: 23, endHour: 7, recordedActivityCount: 7, observedBusyMs: null });
    storage.setState({ settings: settingsParse({ usageNightHoursV1: { startHour: 9, endHour: 17 } }),
      settingsScope: { serverId: 'foreign-home', accountId: 'foreign-account' } });
    expect((await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.howYouWork?.nightShift)
      .not.toEqual(expect.objectContaining({ startHour: 9, endHour: 17 }));
    storage.setState({ settings: settingsParse({}), settingsScope: captured.accountLifetime.scope });
    expect((await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.howYouWork?.nightShift).toBeNull();
  });
  it('projects and refreshes chosen night hours while private Session evidence remains pending', async () => {
    const privateSession = createDeferred<Response>();
    const requestedPrivate = createDeferred<void>();
    const accounting: UsageAnalyticsQueryResponse = { ...value, contributions: [workContribution], activity: {
      weekdayHourBuckets: [{ weekday: 5, hour: 0, eventCount: 7 }, { weekday: 5, hour: 12, eventCount: 3 }] } };
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(accounting)
      : request.path === '/v2/sessions/work-session' ? (requestedPrivate.resolve(), privateSession.promise) : undefined);
    storage.setState({ settingsScope: captured.accountLifetime.scope,
      settings: settingsParse({ usageNightHoursV1: { startHour: 22, endHour: 6 } }) });
    const query = normalizeUsageQuery({ session: 'work-session', period: { startMs: 0, endMs: 86400000 }, timeZoneOffsetMinutes: 120 });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    const night = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork?.nightShift;
    const refreshing = entry.refresh();
    try {
      await requestedPrivate.promise;
      await expect.poll(night).toEqual({ startHour: 22, endHour: 6, recordedActivityCount: 7, observedBusyMs: null });
      expect(entry.getSnapshot().pending).not.toBe('idle');
      storage.setState({ settings: settingsParse({ usageNightHoursV1: { startHour: 9, endHour: 17 } }) });
      await expect.poll(night).toEqual({ startHour: 9, endHour: 17, recordedActivityCount: 3, observedBusyMs: null });
      storage.setState({ settings: settingsParse({ usageNightHoursV1: null }) });
      await expect.poll(night).toBeNull();
    } finally { privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 })); await refreshing; release(); }
  });
  it('keeps the mounted Account owner and its subscription through an identical exact-Home credential write', async () => {
    let response = value;
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(response) : undefined);
    const reference = { hostRead: 'usage.query' as const, input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({})] }) };
    const entry = getUsageQueryResourceStore(captured).getEntry(reference);
    const advanced = createDeferred<void>();
    const release = entry.subscribe(() => {
      const content = entry.getSnapshot().value;
      if (content && decodeUsageQueryResource(content).results[0]?.accounting?.totals.eventCount === 2) advanced.resolve();
    }, true);
    try {
      await entry.refresh();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting).toMatchObject(value);
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      expect(await TokenStorage.setCredentialsForServerUrl(home!.homes.a!.serverUrl,
        { serverId: captured.accountLifetime.scope.serverId }, captured.credentials)).toBe(true);
      expect(captured.accountLifetime.isCurrent()).toBe(true);
      expect(entry.getSnapshot().value).toBeDefined();
      const replacement = captureUiUsageQueryAccountContext(captured.credentials);
      expect(replacement?.accountLifetime).toBe(captured.accountLifetime);
      if (!replacement) throw new Error('Expected unchanged Account owner');
      const nextEntry = getUsageQueryResourceStore(replacement).getEntry(reference);
      expect(nextEntry.getSnapshot()).toBe(entry.getSnapshot());
      response = { ...value, totals: { ...value.totals, eventCount: 2 } };
      publishHomeAccountChange(replacement.accountLifetime.scope.serverId);
      await advanced.promise;
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting).toMatchObject(response);
    } finally { release(); }
  });

  it('withdraws native opened provider facts on genuine authority loss but retains ordinary read failure', async () => {
    const recordKey = { providerId: 'codex', accountSubjectId: 'provider-native', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const now = Date.now();
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'provider-native' }, observedAtMs: now,
      fetchedAtMs: now, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
    let refusal = 0;
    const captured = await context(request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return refusal
        ? new Response('read refused', { status: refusal }) : Response.json({ content: { t: 'plain', v: snapshot },
          metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [] });
      return undefined;
    });
    const serverBasis = getActiveServerSnapshot();
    await getServerFeaturesSnapshot({ serverId: serverBasis.serverId, force: true });
    const providerScope = buildProviderAccountUsageScopeKey({ serverId: captured.accountLifetime.scope.serverId,
      generation: serverBasis.generation, credentialScope: resolveAuthCredentialsScopeKey(captured.credentials) });
    const hook = await renderHook(({ fetchPolicy }: { fetchPolicy: 'poll' | 'cache_only' }) =>
      useProviderAccountUsageSnapshots([snapshot.recordId], { fetchPolicy }), {
      initialProps: { fetchPolicy: 'poll' }, flushOptions: { cycles: 30 },
      wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials: captured.credentials, children }),
    });
    expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]).toEqual(snapshot);
    const reread = async (status: number) => {
      await hook.rerender({ fetchPolicy: 'cache_only' });
      refusal = status;
      await act(async () => { updateProviderAccountUsageCacheEntries(providerScope, entries => ({ ...entries,
        [snapshot.recordId]: { ...entries[snapshot.recordId]!, nextFetchAtMs: 0 } })); });
      await hook.rerender({ fetchPolicy: 'poll' });
      await flushHookEffects({ cycles: 30 });
    };
    await reread(400);
    expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]).toEqual(snapshot);
    await reread(403);
    expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]).toBeNull();
  });

  it.each([false, true])('publishes each current account independently of held history and a failed sibling (failure first: %s)', async failureFirst => {
    let readStarted = 0;
    const timings: Partial<Record<'actionHttp' | 'currentResponse' | 'resourceCurrent' | 'resourceError' | 'settled', number>> = {};
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'ready' };
    const slowRef = { ...ref, accountId: 'slow' };
    const source = { bindingKind: 'account' as const, ref };
    const slowSource = { bindingKind: 'account' as const, ref: slowRef };
    const now = Date.now();
    const recordKey = { providerId: 'codex', accountSubjectId: 'ready', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const slowRecordId = buildProviderAccountUsageRecordId({ ...recordKey, accountSubjectId: 'slow' });
    let retrySlow = false;
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'ready' }, observedAtMs: now,
      fetchedAtMs: now, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'five_hour', label: 'Five hours', used: 40, limit: 100, usedPct: 40, utilizationPct: 40,
        unit: 'count', status: 'ok', resetAtMs: now + 3_600_000, resetsAt: now + 3_600_000, windowDurationMs: 18_000_000 }] });
    const history = createDeferred<Response>();
    const slow = createDeferred<Response>();
    const current = createDeferred<Response>();
    const accounting = createDeferred<Response>();
    const sourceStarted = createDeferred<void>();
    const slowSnapshot = ProviderAccountUsageSnapshotV1Schema.parse({ ...snapshot, recordId: slowRecordId,
      recordKey: { ...recordKey, accountSubjectId: 'slow' }, accountSubject: { kind: 'providerSubject', id: 'slow' } });
    const currentResponse = () => Response.json({ content: { t: 'plain', v: snapshot },
      metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [source] });
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return failureFirst ? accounting.promise.then(response => response.clone()) : Response.json(value);
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        timings.actionHttp ??= performance.now() - readStarted;
        return request.url.searchParams.get('source')?.includes('slow') ? Response.json({ source: slowSource,
          recordId: slowRecordId, providerAccountId: 'slow', fetchedAt: now, staleAfterMs: 60_000 }) : Response.json({ source,
          recordId: snapshot.recordId, providerAccountId: 'ready', fetchedAt: now, staleAfterMs: 60_000 });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') {
        if (request.url.searchParams.get('recordId') === slowRecordId) {
          sourceStarted.resolve();
          return retrySlow ? Response.json({ content: { t: 'plain', v: slowSnapshot },
            metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [slowSource] }) : slow.promise;
        }
        return Promise.resolve(failureFirst ? current.promise : currentResponse())
          .then(response => { timings.currentResponse = performance.now() - readStarted; return response.clone(); });
      }
      // Every HTTP request has its own body, including the sibling and subsequent Retry read.
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') return history.promise.then(response => response.clone());
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    });
    storage.setState({ profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId,
      connectedAccountsV4: [ref, slowRef].map(ref => ({ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] })) }) });
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ period: { relative: '7days' } }] }) });
    const slice = () => { const content = entry.getSnapshot().value; return content ? decodeUsageQueryResource(content).results[0] : undefined; };
    const slowState = () => slice()?.sources.find(state => state.source.startsWith('quota:') && state.source.includes('slow'));
    readStarted = performance.now();
    const release = entry.subscribe(() => {
      if (slice()?.quota?.[0]?.current) timings.resourceCurrent ??= performance.now() - readStarted;
      if (slowState()?.status === 'error') timings.resourceError ??= performance.now() - readStarted;
      if (entry.getSnapshot().pending === 'idle') timings.settled ??= performance.now() - readStarted;
    }, false);
    try {
      if (failureFirst) {
        await sourceStarted.promise;
        slow.resolve(Response.json({ error: 'snapshot_read_failed' }, { status: 503 }));
        await expect.poll(slowState).toMatchObject({ status: 'error', errorCode: 'snapshot_read_failed' });
        expect(slice()?.sources).toContainEqual(expect.objectContaining({ source: 'quota', status: 'pending' }));
        expect(slice()?.quota).toBeUndefined();
        current.resolve(currentResponse());
      }
      await expect.poll(() => slice()?.quota?.[0]?.current).toEqual(snapshot);
      expect(projectUsagePlans(slice()?.quota, now).accounts[0]?.headline?.remainingFraction).toBe(0.6);
      expect(entry.getSnapshot().pending).toBe('initial');
      if (!failureFirst) expect(slowState()).toMatchObject({ status: 'pending' });
      const { UsageCapacityWidget } = await import('@/components/settings/usage/widgets/UsageCapacityWidget');
      const { UsagePlanFitWidget } = await import('@/components/settings/usage/widgets/UsagePlanFitWidget');
      const body = () => {
        const shown = slice()!;
        const model = { requestedQuery: { query: shown.requestedQuery, authority: captured.accountLifetime.scope },
          shownQuery: { query: shown.shownQuery, authority: captured.accountLifetime.scope }, slice: shown,
          pending: shown.pending, error: null, freshness: 'fresh', updatingPreviousPeriod: false,
          refreshing: entry.getSnapshot().pending !== 'idle', refresh: async () => { await entry.refresh(); } } satisfies UsageWidgetBodyModel;
        const props = { model, slice: shown, query: shown.shownQuery, serverId: captured.accountLifetime.scope.serverId };
        return React.createElement(InjectedAuthProvider, { credentials: captured.credentials,
          children: React.createElement(React.Fragment, null,
            React.createElement(UsageCapacityWidget, { ...props, id: 'usage_capacity', testID: 'quota-capacity' }),
            React.createElement(UsagePlanFitWidget, { ...props, id: 'usage_plan_fit', testID: 'quota-fit' })) });
      };
      const screen = await renderScreen(body());
      expect(screen.findByTestId('quota-capacity.cell.ready')).toBeTruthy();
      expect(screen.findByTestId('quota-capacity.cell.slow')).toBeTruthy();
      expect(screen.findByTestId('quota-fit.plan.slow')).toBeTruthy();
      if (!failureFirst) expect(screen.findHostByTestId('quota-capacity.state')).toBeTruthy();
      slow.resolve(Response.json({ error: 'snapshot_read_failed' }, { status: 503 }));
      await expect.poll(slowState).toMatchObject({ status: 'error', errorCode: 'snapshot_read_failed' });
      await screen.update(body());
      expect(screen.findByTestId('quota-capacity.state-action')).toBeTruthy();
      expect(screen.findByTestId('quota-fit.state-action')).toBeTruthy();
      expect(screen.findByTestId('quota-capacity.cell.ready')?.props.accessibilityLabel).toContain('60%');
      expect(slice()?.quota?.[0]?.current).toEqual(snapshot);
      expect(entry.getSnapshot().pending).toBe('initial');
      history.resolve(Response.json({ entries: [], nextCursor: null }));
      accounting.resolve(Response.json(value));
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(slowState()).toMatchObject({ status: 'error', errorCode: 'snapshot_read_failed' });
      expect(slice()?.quota?.[0]?.source).toEqual(source);
      expect(slice()?.quota?.some(read => read.source.ref.accountId === slowSource.ref.accountId)).toBe(false);
      retrySlow = true;
      await screen.pressByTestIdAsync('quota-capacity.state-action');
      await expect.poll(() => slice()?.quota?.find(read => read.source.ref.accountId === 'slow')?.current).toEqual(slowSnapshot);
      await expect.poll(slowState).toMatchObject({ status: 'available' });
      await screen.update(body());
      expect(screen.findHostByTestId('quota-capacity.state')).toBeNull();
      expect(screen.findHostByTestId('quota-fit.state')).toBeNull();
      expect(screen.findByTestId('quota-capacity.cell.slow')?.props.accessibilityLabel).toContain('60%');
      console.info('PERF-PLANS source hop timings', JSON.stringify({ failureFirst, ...timings }));
    } finally { accounting.resolve(Response.json(value)); current.resolve(currentResponse()); slow.resolve(Response.json({ error: 'snapshot_read_failed' }, { status: 503 }));
      history.resolve(Response.json({ entries: [], nextCursor: null })); release(); }
  });

  it('shares the live Account metadata read across allowance sources without retaining a completed price read', async () => {
    const now = Date.now();
    const refs = ['one', 'two'].map(accountId => ({ service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId }));
    const sources = refs.map(ref => ({ bindingKind: 'account' as const, ref }));
    const snapshots = refs.map(ref => {
      const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account' as const, quotaScope: 'account' as const };
      return ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
        providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
        staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [],
        subscription: { status: 'subscribed', renewal: 'on', observedAtMs: now, staleAfterMs: 60_000 } });
    });
    const catalog = createDeferred<void>();
    const catalogStarted = createDeferred<void>();
    let catalogActive = false;
    let enteredAmount = 17;
    const captured = await context(async request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        const index = request.url.searchParams.get('source')?.includes('two') ? 1 : 0;
        return Response.json({ source: sources[index], recordId: snapshots[index]!.recordId, providerAccountId: refs[index]!.accountId,
          fetchedAt: now, staleAfterMs: 60_000 });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') {
        const index = snapshots.findIndex(snapshot => snapshot.recordId === request.url.searchParams.get('recordId'));
        return Response.json({ content: { t: 'plain', v: snapshots[index] },
          metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [sources[index]] });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') return Response.json({ entries: [], nextCursor: null });
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      if (request.path === '/v1/account/entity-rows/connected-metadata/acknowledgements') {
        return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } });
      }
      if (request.path === '/v1/account/entity-rows/connected-metadata/presentation') {
        // The HTTP boundary admits only one live read. Separate Account
        // contexts otherwise issue identical GETs and lose one source's price.
        if (catalogActive) return Response.json({ error: 'duplicate_read' }, { status: 429 });
        catalogActive = true;
        catalogStarted.resolve();
        try {
          await catalog.promise;
          return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1,
            entries: refs.map(account => ({ v: 1, label: '', subject: { kind: 'account', account },
              subscriptionMonthlyPrice: { amount: enteredAmount, currency: 'USD', enteredAtMs: now } })) } } });
        } finally { catalogActive = false; }
      }
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId,
      connectedAccountsV4: refs.map(ref => ({ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] })) }) });
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const input = { queries: [normalizeUsageQuery({ period: { startMs: now - 1000, endMs: now + 1000 } })] };
    const reading = readUiUsageQueryBatch(captured, input);
    try {
      await catalogStarted.promise;
      await flushHookEffects({ cycles: 20 });
      catalog.resolve();
      const first = await reading;
      console.info('PERF-PLANS shared Account reader', JSON.stringify({ sources: refs.length,
        currentnessReads: home!.requests.filter(request => request.path === '/v1/account/encryption/currentness').length,
        presentationReads: home!.requests.filter(request => request.path === '/v1/account/entity-rows/connected-metadata/presentation').length }));
      expect(first.results[0]?.quota?.map(row => row.current?.subscription?.enteredMonthlyPrice?.amount)).toEqual([17, 17]);
      enteredAmount = 29;
      const fresh = await readUiUsageQueryBatch(captured, input);
      expect(fresh.results[0]?.quota?.map(row => row.current?.subscription?.enteredMonthlyPrice?.amount)).toEqual([29, 29]);
    } finally { catalog.resolve(); await reading.catch(() => {}); }
  });

  it('opens first-use B from qualified profile sources without cache hydration and publishes accepted history before a held later page', async () => {
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'first-use' };
    const source = { bindingKind: 'account' as const, ref };
    const now = Date.parse('2026-10-11T21:30:05.321Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const historyRanges: { startAtMs: number; endAtMs: number }[] = [];
    const recordKey = { providerId: 'codex', accountSubjectId: 'first-use', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'first-use' }, observedAtMs: now,
      fetchedAtMs: now, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
    const later = createDeferred<Response>();
    const pending = createDeferred<Response>();
    let sourceRefusal = 0;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return sourceRefusal
        ? new Response('missing', { status: sourceRefusal }) : Response.json({ source, recordId: snapshot.recordId,
          providerAccountId: 'first-use', fetchedAt: now, staleAfterMs: 60_000 });
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({ content: { t: 'plain', v: snapshot },
        metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [source] });
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') {
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
          request.url.searchParams.get('query'));
        if ('history' in query && query.history.range) historyRanges.push(query.history.range);
        if ('history' in query && query.history.cursor) return later.promise.then(response => response.clone());
        return Response.json({ entries: [{ id: 'first-use-page', observedAtMs: now, record: { content: { t: 'plain', v: snapshot },
          metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [source] } }],
          nextCursor: { id: 'first-use-page', observedAtMs: now } });
      }
      if (request.path === '/v2/pending/reset-starts/read') return pending.promise.then(response => response.clone());
      return undefined;
    });
    storage.setState({ profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId,
      connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] }) });
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const providerScope = buildProviderAccountUsageScopeKey({ serverId: captured.accountLifetime.scope.serverId,
      generation: getActiveServerSnapshot().generation, credentialScope: resolveAuthCredentialsScopeKey(captured.credentials) });
    expect(getProviderAccountUsageCacheState().entriesByCredentialScope[providerScope]?.[snapshot.recordId]?.snapshot).toBeUndefined();
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ period: { relative: '7days' } }] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await expect.poll(() => {
        const content = entry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results[0]?.quota?.[0]?.current;
      }).toEqual(snapshot);
      pending.resolve(Response.json({ entries: [] }));
      await expect.poll(() => {
        const content = entry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results[0]?.quota?.[0]?.history?.entries.length;
      }).toBe(1);
      expect(historyRanges[0]).toEqual({ startAtMs: Date.parse('2026-10-05T00:00:00Z'), endAtMs: now });
      expect(entry.getSnapshot().pending).toBe('initial');
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]).toMatchObject({ accounting: value,
        quota: [{ source, current: snapshot, history: { nextCursor: { id: 'first-use-page' } }, unusedCapacity: { historyStatus: 'partial' } }] });
      later.resolve(Response.json({ entries: [], nextCursor: null }));
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      sourceRefusal = 500;
      await entry.refresh();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0]?.current).toEqual(snapshot);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual(expect.objectContaining({ source: 'quota', status: 'stale' }));
      sourceRefusal = 404;
      await entry.refresh();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0]?.current).toBeNull();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual(expect.objectContaining({ source: expect.stringMatching(/^quota:/), status: 'available' }));
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual(expect.objectContaining({ source: 'quota', status: 'available' }));
      await entry.refresh();
      expect(entry.getSnapshot().error).toBeUndefined();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0]?.current).toBeNull();
    } finally { pending.resolve(Response.json({ entries: [] })); later.resolve(Response.json({ entries: [], nextCursor: null })); release(); }
  });

  it('publishes A and admitted B independently of cache hydration and advances history without vendor refresh', async () => {
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
    const source = { bindingKind: 'account' as const, ref };
    let quotaEnabled = true;
    let quotaRefusal = 0;
    let historyUnavailable = false;
    let laterHistoryUnavailable = false;
    let laterHistoryDenied = false;
    let holdLaterHistory = false;
    let accountingResponse = value;
    const laterHistory = createDeferred<Response>();
    let heldHistoryResponse: Response | undefined;
    const recordKey = { providerId: 'codex', accountSubjectId: 'provider-work', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const now = Date.now();
    const snapshot = { v: 1 as const, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject' as const, id: 'provider-work' },
      observedAtMs: now, fetchedAtMs: now, staleAfterMs: 60_000, source: 'providerHttp' as const,
      confidence: 'confirmed' as const, state: 'loaded_empty' as const, meters: [] };
    const quota = { v: 1, ref, activeAccountId: 'provider-work', fetchedAt: now, staleAfterMs: 60_000,
      planLabel: null, accountLabel: null, meters: [] };
    ProviderAccountUsageSnapshotV1Schema.parse(snapshot);
    const quotaResponse = QualifiedConnectedAccountQuotaResponseV4Schema.parse({ ref,
      sourceResolution: { source, recordId: snapshot.recordId, providerAccountId: 'provider-work', fetchedAt: now, staleAfterMs: 60_000 },
      content: { t: 'plain', v: quota }, metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' } });
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(accountingResponse);
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
        connectedServices: { enabled: true, quotas: { enabled: quotaEnabled } },
      } }));
      if (request.path === '/v4/connect/qualified/quotas') return quotaRefusal
        ? new Response('read refused', { status: quotaRefusal }) : Response.json(quotaResponse);
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({
        content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [source] });
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return quotaRefusal === 403
        ? new Response('source refused', { status: 403 }) : Response.json({ source, recordId: snapshot.recordId,
          providerAccountId: 'provider-work', fetchedAt: now, staleAfterMs: 60_000 });
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') {
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
          request.url.searchParams.get('query'));
        const later = 'history' in query && query.history.cursor !== undefined;
        if (historyUnavailable || later && laterHistoryUnavailable) return new Response('history unavailable', { status: 404 });
        if (later && laterHistoryDenied) return new Response('history refused', { status: 403 });
        const id = later ? 'second' : 'first';
        const observedAtMs = now - (later ? 200 : 700);
        const used = later ? 70 : 20;
        const historical = { ...snapshot, observedAtMs, fetchedAtMs: observedAtMs, state: 'loaded_data',
          meters: [{ meterId: 'ended', label: 'Ended', used, remaining: 100 - used, limit: 100, unit: 'requests',
            utilizationPct: used, resetsAt: now - 200, windowDurationMs: 1000, status: 'ok', details: {} }] };
        const response = Response.json({ entries: [{ id, observedAtMs, record: {
          content: { t: 'plain', v: historical },
          metadata: { fetchedAt: observedAtMs, staleAfterMs: 60_000, status: 'ok' }, sources: [source] } }],
          nextCursor: later ? null : { id, observedAtMs } });
        if (later && holdLaterHistory) { heldHistoryResponse = response; return laterHistory.promise.then(page => page.clone()); }
        return response;
      }
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    });
    storage.setState({ profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId,
      connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] }) });
    const serverBasis = getActiveServerSnapshot();
    expect((await getServerFeaturesSnapshot({ serverId: serverBasis.serverId, force: true })).status).toBe('ready');
    const credentialScope = [captured.accountLifetime.scope.serverId, String(serverBasis.generation), resolveAuthCredentialsScopeKey(captured.credentials)].join('\u0000');
    const readContext = { credentials: captured.credentials, credentialScope, ref,
      serverBasis: { serverId: captured.accountLifetime.scope.serverId, generation: serverBasis.generation },
      assertOperationAllowed: async () => { throw new Error('Passive hydration must not refresh a provider'); } };
    const qualifiedKey = buildQualifiedQuotaSnapshotScopeKey(readContext);
    const qualifiedReady = createDeferred<void>();
    const unwatchQualified = subscribeQualifiedQuotaSnapshotEntry(qualifiedKey, () => {
      if (getQualifiedQuotaSnapshotEntry(qualifiedKey).read) qualifiedReady.resolve();
    });
    loadQualifiedQuotaSnapshotOnce(qualifiedKey, readContext);
    await qualifiedReady.promise;
    expect(getQualifiedQuotaSnapshotEntry(qualifiedKey)).toMatchObject({ supported: true, usageRecordId: snapshot.recordId });
    const providerScope = buildProviderAccountUsageScopeKey({ serverId: captured.accountLifetime.scope.serverId,
      generation: serverBasis.generation, credentialScope: resolveAuthCredentialsScopeKey(captured.credentials) });
    updateProviderAccountUsageCacheEntries(providerScope, () => ({ [snapshot.recordId]: {
      snapshot: null, loading: true, hadError: false, nextFetchAtMs: now, consecutiveErrors: 0 } }));
    const query = normalizeUsageQuery({});
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const advanced = createDeferred<void>();
    const release = entry.subscribe(() => {
      const content = entry.getSnapshot().value;
      if (content && decodeUsageQueryResource(content).results[0]?.quota?.[0]?.current?.recordId === snapshot.recordId) advanced.resolve();
    }, true);
    try {
      await entry.refresh();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]).toMatchObject({ accounting: value,
        quota: [{ current: snapshot }], sources: expect.arrayContaining([{ source: 'quota', status: 'available', asOfMs: now }]) });
      const opened = await getProviderAccountUsageSnapshotPlain(captured.credentials, { recordId: snapshot.recordId },
        { expectedActiveServer: readContext.serverBasis });
      updateProviderAccountUsageCacheEntries(providerScope, entries => ({ ...entries, [snapshot.recordId]: {
        snapshot: opened, loading: false, hadError: false, nextFetchAtMs: now + 60_000, consecutiveErrors: 0 } }));
      await advanced.promise;
      // Cache hydration can start another progressive read. Observe identity and
      // waiting work together in one revision, after its Pending read answers.
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0]).toMatchObject({ source,
        current: snapshot, waitingWork: { status: 'available', entries: [] } });
      const fullRead = (await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.quota?.[0];
      expect(fullRead?.history?.entries.map(entry => entry.id)).toEqual(['first', 'second']);
      expect(fullRead?.history?.nextCursor).toBeNull();
      expect(fullRead?.unusedCapacity).toMatchObject({ historyStatus: 'returned_page', windows: [{ value: {
        status: 'available', method: 'terminal_observation', qualification: 'confirmed', sampleCount: 2 } }] });
      expect(fullRead?.unusedCapacity?.windows[0]?.value).toHaveProperty('unusedAmount', expect.closeTo(30));
      holdLaterHistory = true;
      accountingResponse = { ...value, totals: { ...value.totals, eventCount: 2 } };
      const refreshingHistory = entry.refresh();
      await expect.poll(() => {
        const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0];
        return slice?.accounting?.totals.eventCount === 2 && slice.quota?.[0]?.history?.entries.length === 1;
      }).toBe(true);
      expect(entry.getSnapshot().pending).toBe('refresh');
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0]).toMatchObject({ current: snapshot,
        history: { nextCursor: { id: 'first' } }, unusedCapacity: { historyStatus: 'partial' } });
      holdLaterHistory = false;
      laterHistory.resolve(heldHistoryResponse!);
      await refreshingHistory;
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0]?.history?.entries).toHaveLength(2);
      laterHistoryUnavailable = true;
      const partialRead = (await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.quota?.[0];
      expect(partialRead).toMatchObject({
        current: snapshot, history: { entries: [{ id: 'first' }], nextCursor: { id: 'first' } },
        unusedCapacity: { historyStatus: 'partial', windows: [{ value: {
          status: 'available', method: 'linear_pace_at_last_observation', qualification: 'estimated', sampleCount: 1 } }] } });
      expect(partialRead?.unusedCapacity?.windows[0]?.value).toHaveProperty('unusedAmount', expect.closeTo(60));
      laterHistoryUnavailable = false;
      laterHistoryDenied = true;
      expect((await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.quota?.[0]).toBeUndefined();
      laterHistoryDenied = false;
      historyUnavailable = true;
      expect((await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.quota?.[0]).toMatchObject({
        current: snapshot, unusedCapacity: { historyStatus: 'unavailable', windows: [] } });
      historyUnavailable = false;
      await flushHookEffects({ cycles: 30 });
      const connectedProfile = storage.getState().profile;
      storage.setState({ profile: { ...connectedProfile, connectedAccountsV4: [] } });
      await flushHookEffects({ cycles: 30 });
      expect.soft(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota).toBeUndefined();
      storage.setState({ profile: connectedProfile });
      quotaRefusal = 400;
      await reloadQualifiedQuotaSnapshotAfterRecovery({ ref, serverBasis: readContext.serverBasis });
      const offline = (await readUiUsageQueryBatch(captured, { queries: [query] })).results[0];
      expect(offline?.quota?.[0]?.current).toEqual(snapshot);
      // A refused legacy cache read cannot override an admitted fresh record Action.
      expect.soft(offline?.sources).toContainEqual({ source: 'quota', status: 'available', asOfMs: now });
      quotaEnabled = false;
      await getServerFeaturesSnapshot({ serverId: serverBasis.serverId, force: true });
      const ownSettingsScope = storage.getState().settingsScope;
      storage.setState({ settingsScope: { serverId: 'foreign-home', accountId: 'foreign-account' } });
      expect.soft((await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.quota).toBeUndefined();
      storage.setState({ settingsScope: ownSettingsScope });
      quotaEnabled = true;
      await getServerFeaturesSnapshot({ serverId: serverBasis.serverId, force: true });
      quotaRefusal = 403;
      await reloadQualifiedQuotaSnapshotAfterRecovery({ ref, serverBasis: readContext.serverBasis });
      expect.soft(getQualifiedQuotaSnapshotEntry(qualifiedKey)).toMatchObject({ supported: false, snapshot: null, usageRecordId: null });
      expect.soft((await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.quota).toBeUndefined();
      expect(home!.requests.some(request => request.path.endsWith('/refresh'))).toBe(false);
    } finally { laterHistory.resolve(heldHistoryResponse ?? Response.json({ error: 'not_found' }, { status: 404 })); release(); unwatchQualified(); }
  });

  it('opens the quota host read through the captured plain Account and retires late provider facts', async () => {
    const source = { bindingKind: 'account' as const, ref: {
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' } };
    const delayed = createDeferred<Response>();
    const issued = createDeferred<void>();
    let held = false;
    let denied = false;
    const captured = await context(request => {
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        if (denied) return new Response('forbidden', { status: 403 });
        if (held) { issued.resolve(); return delayed.promise; }
        return Response.json({ error: 'not_found' }, { status: 404 });
      }
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'connectedServices.quota.get', input: { source } });
    const release = entry.subscribe(() => {}, false);
    try {
      const admitted = await entry.refresh();
      expect(admitted.value).toBeDefined();
      expect(JSON.parse(new TextDecoder().decode(admitted.value!.bytes))).toMatchObject({ source, current: null,
        pace: [], targets: [], waitingWork: { status: 'available', entries: [] } });
      expect(home!.requests.filter(request => request.path.includes('/provider-account-usage/'))
        .every(request => request.method === 'GET')).toBe(true);
      expect(getUsageQueryResourceStore(captured).getEntry({ hostRead: 'connectedServices.quota.get', input: {
        source: { ref: { accountId: 'work', service: { localId: 'openai-codex', pluginId: 'happier.agent.codex' } }, bindingKind: 'account' },
      } }).getSnapshot()).toBe(entry.getSnapshot());
      denied = true;
      expect((await entry.refresh()).value).toBeUndefined();
      denied = false;
      expect((await entry.refresh()).value).toBeDefined();
      held = true;
      const refreshing = entry.refresh();
      await issued.promise;
      retireActiveServerAccountScopeLifetime();
      delayed.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
      await refreshing;
      expect(entry.getSnapshot().value).toBeUndefined();
    } finally { release(); }
  });

  it('advances a non-live Resource from useful A through slow private detail without establishing a watch', async () => {
    const session = createDeferred<Response>();
    const work = createDeferred<unknown>();
    const accounting = { ...value, contributions: [{ ...workContribution, sessionId: 'staged-session' }] };
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(accounting);
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (request.path === '/v2/sessions/staged-session') return session.promise;
      if (request.path === '/v1/sessions/staged-session/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    storage.getState().applySessions([createSessionFixture({ id: 'staged-session', active: true,
      serverId: captured.accountLifetime.scope.serverId, metadata: { machineId: 'work-machine', path: '/repo', host: 'test', homeDir: '/home/test' } })]);
    storage.getState().applyMachines([createMachineFixture({ id: 'work-machine' })]);
    scmTransport.mockImplementation(() => work.promise);
    const query = normalizeUsageQuery({ session: 'staged-session', period: { startMs: 0, endMs: 1000 } });
    const entry = getUsageQueryResourceStore(captured)
      .getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const detailCompleted = createDeferred<void>();
    const release = entry.subscribe(() => {
      const content = entry.getSnapshot().value;
      if (content && decodeUsageQueryResource(content).results[0]?.sources.some(source =>
        source.source === 'how_you_work' && source.status !== 'pending')) {
        detailCompleted.resolve();
      }
    }, false);
    try {
      await flushHookEffects({ cycles: 30 });
      const initial = entry.getSnapshot().value;
      expect(initial).toBeDefined();
      expect(decodeUsageQueryResource(initial!).results[0]).toMatchObject({ accounting,
        sources: expect.arrayContaining([{ source: 'work', status: 'pending' }, { source: 'how_you_work', status: 'pending' }]),
      });
      work.resolve({ success: true, pullRequests: [] });
      session.resolve(Response.json({ session: { id: 'staged-session', createdAt: 1, updatedAt: 900, seq: 1,
        ...ownerSessionAccess,
        active: true, activeAt: 900, encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ name: 'Opened' }), agentStateVersion: 1, agentState: null, share: null } }));
      await detailCompleted.promise;
      const completed = decodeUsageQueryResource(entry.getSnapshot().value!).results[0];
      expect(completed?.accounting).toMatchObject(accounting);
      expect(completed?.sources).toContainEqual({ source: 'work', status: 'unsupported' });
      expect(completed?.howYouWork?.detailStatus).toBe('partial');
      expect(completed?.sources.some(source => source.source === 'how_you_work' && source.status === 'pending')).toBe(false);
    } finally { release(); }
  });

  it.each([{}, { projects: ['project'] }, { sources: ['runtime'] }])('opens aggregate composition and accepted delivery within scope %j', async filters => {
    const composition = { v: 1, evidenceId: 'composition', sessionId: 'coach-session', turnId: 'turn', inputId: 'input',
      observedAtMs: 300, boundary: 'host_pre_dispatch', deliveryKind: 'newTurn', coverage: 'host_only',
      components: ['a', 'c'].map(source => ({ sourceId: source.repeat(64), digest: 'b'.repeat(64),
        kind: 'instructions', location: 'user', byteLength: 200, tokenCount: null, tokenizerId: null,
        cacheClass: 'unknown', overlap: 'none' })), nativePrefix: null, contextWindowTokens: null };
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: [
        { ...workContribution, sessionId: 'coach-session', projectKey: 'project', source: 'runtime' },
      ] });
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (request.path === '/v2/sessions/coach-session') return Response.json({ session: {
        id: 'coach-session', createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        ...ownerSessionAccess,
        metadataVersion: 1, metadata: JSON.stringify({ name: 'Opened', path: '/workspace/project', machineId: 'machine',
          agent: 'codex', agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } }),
        agentStateVersion: 1, agentState: null, share: null,
      } });
      if (request.path === '/v1/sessions/coach-session/messages') {
        // Real role filtering is the HTTP boundary: a user-only read cannot see host events.
        const admitted = request.url.searchParams.get('roles')?.split(',').includes('event');
        return Response.json({ messages: admitted ? [{ id: 'composition-row', seq: 1, localId: null, createdAt: 300,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: 'composition-event',
            data: { type: 'prompt-composition', composition } } } },
        }, { id: 'accepted-row', seq: 2, localId: 'input', createdAt: 300,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private aggregate prompt' } } },
          deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: {
            v: 1, acceptedAtMs: 500, delivery: { kind: 'steer', turnId: 'turn' },
          } } },
        }, { id: 'foreign-turn-row', seq: 3, localId: 'foreign-input', createdAt: 400,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private foreign turn' } } },
          deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: {
            v: 1, acceptedAtMs: 600, delivery: { kind: 'steer', turnId: 'foreign-turn' },
          } } },
        }, ...(request.url.searchParams.get('roles')?.split(',').includes('agent') ? [{ id: 'mixed-claude-tool', seq: 4,
          localId: null, createdAt: 450, messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: {
            type: 'output', data: { type: 'assistant', message: { role: 'assistant', content: [
              { type: 'text', text: 'private mixed Claude prose' },
              { type: 'tool_use', id: 'mixed-read', name: 'Read', input: { file_path: '/private/mixed' } },
            ] } },
          } } } }] : [])] : [], hasMore: false });
      }
      return undefined;
    });
    const result = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({
      ...filters, period: { startMs: 0, endMs: 1000 },
    })] });
    expect(result.results[0]).toHaveProperty('coach.findings', expect.arrayContaining([
      expect.objectContaining({ detectorId: 'duplicated_instructions', coverage: 'partial' }),
    ]));
    expect(result.results[0]).toHaveProperty('coach.evaluations', expect.arrayContaining([
      expect.objectContaining({ detectorId: 'cache_busting_prompt_changes', status: 'insufficient_evidence' }),
    ]));
    expect(JSON.stringify(result)).not.toContain('Opened');
    expect(JSON.stringify(result)).not.toContain('private aggregate prompt');
    expect(JSON.stringify(result)).not.toContain('private foreign turn');
    expect(JSON.stringify(result)).not.toContain('private mixed Claude prose');
    expect(JSON.stringify(result)).not.toContain('/private/mixed');
    if (Object.keys(filters).length === 0) expect(result.results[0]?.howYouWork?.autopsy?.events)
      .toContainEqual({ evidenceId: 'mixed-read', sessionId: 'coach-session', turnId: null, observedAtMs: 450,
        kind: 'read', method: 'tool_classification' });
    expect(result.results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: Object.keys(filters).length ? 1 : 2 });
    const finding = result.results[0]?.coach?.findings.find(row => row.detectorId === 'duplicated_instructions');
    expect(finding).toMatchObject({ remedy: { kind: 'prepared_session', input: {
      executionTarget: { serverId: captured.accountLifetime.scope.serverId, machineId: 'machine' },
      directory: { kind: 'path', path: '/workspace/project' },
    } }, action: { actionId: 'usage.coach.apply' } });
    if (!finding) throw new Error('Expected witnessed Coach finding');
    await storage.getState().activateSettingsScope(captured.accountLifetime.scope);
    storage.getState().applySettingsLocal({ usageCoachPreferencesV1: {
      ...storage.getState().settings.usageCoachPreferencesV1, suppressions: [{ kind: 'dismissed', evidenceKey: finding.evidenceKey }],
    } });
    expect(storage.getState().settings.usageCoachPreferencesV1.suppressions)
      .toContainEqual({ kind: 'dismissed', evidenceKey: finding.evidenceKey });
    const reread = await readUiUsageQueryBatch(captured, { queries: [result.results[0]!.requestedQuery] });
    expect(reread.results[0]?.coach?.findings.find(row => row.evidenceKey === finding.evidenceKey)?.state.dismissed).toBe(true);
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [result.results[0]!.requestedQuery] }) });
    const release = entry.subscribe(() => {}, true);
    try {
      await entry.refresh();
      await flushHookEffects({ cycles: 30 });
      const mountedFinding = () => {
        const content = entry.getSnapshot().value;
        return content ? decodeUsageQueryResource(content).results[0]?.coach?.findings
          .find(row => row.evidenceKey === finding.evidenceKey) : undefined;
      };
      expect(mountedFinding()?.state.dismissed).toBe(true);
      storage.getState().applySettingsLocal({ usageCoachPreferencesV1: {
        ...storage.getState().settings.usageCoachPreferencesV1, suppressions: [],
      } });
      await flushHookEffects({ cycles: 30 });
      await expect.poll(() => mountedFinding()?.state.dismissed).toBe(false);
      storage.getState().applySettingsLocal({ usageCoachPreferencesV1: {
        ...storage.getState().settings.usageCoachPreferencesV1, disabledChecks: ['duplicated_instructions'],
      } });
      await expect.poll(() => mountedFinding()).toBeUndefined();
      const configured = entry.getSnapshot().value;
      expect(configured && decodeUsageQueryResource(configured).results[0]?.coach?.evaluations
        .find(row => row.detectorId === 'duplicated_instructions')?.status).toBe('disabled');
    } finally { release(); }
  });
  it('keeps a failed pinned slice independent from available accounting in the same page batch', async () => {
    const captured = await context(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const body = request.body;
      const filtered = body && typeof body === 'object' && 'filters' in body && body.filters
        && typeof body.filters === 'object' && 'machineIds' in body.filters;
      return filtered ? Response.json({ error: 'refused' }, { status: 400 }) : Response.json(value);
    });
    const result = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({}), normalizeUsageQuery({ machines: ['bad'] })] });
    const available = result.results.find(slice => slice.requestedQuery.machines.length === 0);
    const failed = result.results.find(slice => slice.requestedQuery.machines.includes('bad'));
    expect(available?.accounting).toMatchObject(value);
    expect(failed?.accounting).toBeUndefined();
    expect(failed?.sources).toContainEqual({ source: 'accounting', status: 'error', errorCode: 'usage_query_failed' });
  });

  it.each([true, false])('respects a denied transcript capability for explicit Session selection %s', async explicit => {
    const deniedAccess = createSessionAccessFixture('view', { readTranscript: false });
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: [
        { ...workContribution, sessionId: 'denied-session' },
      ] });
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (request.path === '/v2/sessions/denied-session') return Response.json({ session: {
        ...ownerSessionAccess,
        effectiveAccess: { v: 1, level: deniedAccess.level, sources: [{ kind: 'direct', shareId: 'denied-share' }],
          capabilities: deniedAccess.capabilities },
        id: 'denied-session', createdAt: 1, updatedAt: 900, seq: 2, active: true, activeAt: 900,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ name: 'Denied' }), agentStateVersion: 1,
        agentState: JSON.stringify({ completedRequests: { request: { tool: 'Bash', arguments: {},
          turnId: 'turn', createdAt: 200, completedAt: 400, status: 'approved' } } }), share: null,
      } });
      if (request.path === '/v1/sessions/denied-session/messages') return Response.json({ messages: [{
        id: 'accepted-row', seq: 2, localId: 'accepted-input', createdAt: 300,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'denied private input' } } },
        deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: {
          v: 1, acceptedAtMs: 500, delivery: { kind: 'steer', turnId: 'turn' },
        } } },
      }], hasMore: false });
      return undefined;
    });
    const result = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({
      ...(explicit ? { session: 'denied-session' } : {}), period: { startMs: 0, endMs: 1000 },
    })] });
    expect(result.results[0]?.accounting).toMatchObject(value);
    expect(result.results[0]?.howYouWork).toMatchObject({ detailStatus: 'unknown', intervals: null,
      inputs: null, permissions: null });
    expect(home!.requests.some(request => request.path === '/v1/sessions/denied-session/messages')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('denied private input');
  });

  it('opens retained accepted delivery through the selected Session reader and keeps unseen history partial', async () => {
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (request.path === '/v2/sessions/fresh-session') return Response.json({ session: {
        ...ownerSessionAccess,
        id: 'fresh-session', createdAt: 1, updatedAt: 900, seq: 2, active: true, activeAt: 900,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ name: 'Opened' }),
        agentStateVersion: 1, agentState: null, share: null,
      } });
      if (request.path === '/v1/sessions/fresh-session/messages') return Response.json({ messages: [{
        id: 'accepted-row', seq: 2, localId: 'accepted-input', createdAt: 300,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private prompt text' } } },
        deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: {
          v: 1, acceptedAtMs: 500, delivery: { kind: 'steer', turnId: 'turn' },
        } } },
      }], hasMore: true, nextBeforeSeq: 2 });
      return undefined;
    });
    const result = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({
      session: 'fresh-session', period: { startMs: 0, endMs: 1000 },
    })] });
    expect(result.results[0]?.howYouWork).toMatchObject({
      detailStatus: 'partial', inputs: { acceptedCount: 1, steeringCount: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('private prompt text');
  });

  it.each([503, 403, 404])('retains fresh authorized Session facts only for ordinary input-page failure %s', async status => {
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: [
        { ...workContribution, sessionId: 'failed-inputs' },
      ] });
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (request.path === '/v2/sessions/failed-inputs') return Response.json({ session: {
        ...ownerSessionAccess,
        id: 'failed-inputs', createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ name: 'Opened' }), agentStateVersion: 1,
        agentState: JSON.stringify({ completedRequests: { request: { tool: 'Bash',
          arguments: { private: 'fresh-private-argument' }, turnId: 'turn', createdAt: 300, completedAt: 500,
          status: 'approved', answeringClientCategory: 'ios' } } }), share: null,
      } });
      if (request.path === '/v1/sessions/failed-inputs/turns') return Response.json({ v: 1,
        sessionId: 'failed-inputs', updatedAt: 900, turns: [{ turnId: 'turn', agentId: 'codex',
          status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 }] });
      if (request.path === '/v1/sessions/failed-inputs/messages') return Response.json({ error: 'unavailable' }, { status });
      return undefined;
    });
    const result = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({
      period: { startMs: 0, endMs: 1000 },
    })] });
    expect(result.results[0]?.howYouWork).toMatchObject(status === 503 ? {
      detailStatus: 'partial', intervals: { agentTimeMs: 600 }, inputs: null,
      permissions: { pairedDecisionCount: 1, decisionLatencyMs: 200, byAnsweringClient: { ios: 1 } },
    } : { detailStatus: 'unknown', intervals: null, inputs: null, permissions: null });
    expect(JSON.stringify(result)).not.toContain('fresh-private-argument');
  });

  it('distinguishes unopened nonempty input pages from observed empty pages and retains opened subsets', async () => {
    let pageKind: 'unopened' | 'legacy' | 'empty' | 'partial' = 'unopened';
    const unopenedRows = [
      { id: 'mode-mismatch', seq: 1, localId: null, createdAt: 100, content: { t: 'encrypted', c: 'unavailable' } },
      { id: 'invalid-record', seq: 2, localId: null, createdAt: 200, content: { t: 'plain', v: { unavailable: true } } },
    ];
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (request.path === '/v2/sessions/page-session') return Response.json({ session: {
        ...ownerSessionAccess,
        id: 'page-session', createdAt: 1, updatedAt: 900, seq: 3, active: true, activeAt: 900,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ name: 'Opened' }), agentStateVersion: 1,
        agentState: JSON.stringify({ completedRequests: { request: { tool: 'Bash', arguments: {},
          turnId: 'turn', createdAt: 200, completedAt: 400, status: 'approved' } } }), share: null,
      } });
      if (request.path === '/v1/sessions/page-session/messages') return Response.json({ messages:
        pageKind === 'empty' ? [] : pageKind === 'unopened' ? unopenedRows : pageKind === 'legacy' ? [{
          id: 'legacy-row', seq: 3, localId: 'legacy-input', createdAt: 500,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private legacy input' } } },
        }] : [...unopenedRows, {
          id: 'opened-row', seq: 3, localId: 'accepted-input', createdAt: 500,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private input' } } },
          deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: {
            v: 1, acceptedAtMs: 500, delivery: { kind: 'steer', turnId: 'turn' },
          } } },
        }], hasMore: false });
      return undefined;
    });
    const input = { queries: [normalizeUsageQuery({ session: 'page-session', period: { startMs: 0, endMs: 1000 } })] };
    const unopened = await readUiUsageQueryBatch(captured, input);
    expect(unopened.results[0]?.howYouWork).toMatchObject({ detailStatus: 'partial', inputs: null,
      permissions: { pairedDecisionCount: 1, decisionLatencyMs: 200 } });
    pageKind = 'legacy';
    const legacy = await readUiUsageQueryBatch(captured, input);
    expect(legacy.results[0]?.howYouWork).toMatchObject({ detailStatus: 'partial', inputs: null,
      permissions: { pairedDecisionCount: 1, decisionLatencyMs: 200 } });
    expect(JSON.stringify(legacy)).not.toContain('private legacy input');
    pageKind = 'empty';
    const empty = await readUiUsageQueryBatch(captured, input);
    expect(empty.results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: 0, steeringCount: 0 });
    pageKind = 'partial';
    const partial = await readUiUsageQueryBatch(captured, input);
    expect(partial.results[0]?.howYouWork).toMatchObject({ detailStatus: 'partial',
      inputs: { acceptedCount: 1, steeringCount: 1 }, permissions: { pairedDecisionCount: 1 } });
    expect(JSON.stringify(partial)).not.toContain('private input');
  });

  it('excludes loaded Session candidates while the storage projection belongs to another Account', async () => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    storage.setState({ profileScope: { ...captured.accountLifetime.scope, accountId: 'foreign-account' }, sessions: {
      foreign: createSessionFixture({ id: 'foreign', serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain',
        sessionTurns: { v: 1, sessionId: 'foreign', updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 },
        ] } }),
    } });
    await expect(readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } })] }))
      .rejects.toMatchObject({ code: 'stale_surface' });
    expect(home!.requests.some(request => request.path === '/v2/sessions/foreign')).toBe(false);
  });

  it('projects only the opened active Account subset as partial private evidence without exporting request arguments', async () => {
    const turns = { v: 1, sessionId: 'loaded-session', updatedAt: 900, turns: [
      { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 },
    ] };
    const agentState = { completedRequests: { request: {
      tool: 'Bash', arguments: { secret: 'never-export-this' }, turnId: 'turn',
      createdAt: 300, completedAt: 500, status: 'approved', answeringClientCategory: 'ios',
    } } };
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (request.path === '/v2/sessions/loaded-session') return Response.json({ session: { ...ownerSessionAccess,
        id: 'loaded-session', createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ name: 'Opened' }), agentStateVersion: 1, agentState: JSON.stringify(agentState), share: null,
      } });
      if (request.path === '/v1/sessions/loaded-session/turns') return Response.json(turns);
      if (request.path === '/v1/sessions/loaded-session/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    storage.getState().applySessions([{
      id: 'loaded-session', serverId: captured.accountLifetime.scope.serverId,
      seq: 1, createdAt: 1, updatedAt: 900, active: true, activeAt: 900,
      encryptionMode: 'plain', metadata: null, metadataVersion: 0, agentStateVersion: 1,
      thinking: false, thinkingAt: 900,
      sessionTurns: { v: 1, sessionId: 'loaded-session', updatedAt: 900, turns: [
        { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 },
      ] },
      agentState: { completedRequests: { request: {
        tool: 'Bash', arguments: { secret: 'never-export-this' }, turnId: 'turn',
        createdAt: 300, completedAt: 500, status: 'approved', answeringClientCategory: 'ios',
      } } },
    }]);
    const result = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } })] });
    expect(result.results[0]?.howYouWork).toMatchObject({
      detailStatus: 'partial', intervals: { agentTimeMs: 600 },
      permissions: { pairedDecisionCount: 1, decisionLatencyMs: 200, byAnsweringClient: { ios: 1 } },
    });
    expect(JSON.stringify(result)).not.toContain('never-export-this');
  });

  it('shares private Session evidence while seq is unchanged and isolates consumer retirement', async () => {
    let detailGate = createDeferred<void>();
    let permissionCompletedAt = 200;
    const captured = await context(async request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      const sessionId = request.path === '/v2/sessions/shared' ? 'shared'
        : request.path === '/v2/sessions/other' ? 'other' : null;
      if (sessionId) {
        const completedAt = permissionCompletedAt;
        if (sessionId === 'shared') await detailGate.promise;
        return Response.json({ session: { ...ownerSessionAccess, id: sessionId,
          createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
          encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
          metadataVersion: 1, metadata: JSON.stringify({ name: sessionId }),
          agentStateVersion: 1, agentState: JSON.stringify({ completedRequests: { request: {
            tool: 'Bash', turnId: 'turn', createdAt: 100, completedAt, status: 'approved',
          } } }), share: null } });
      }
      if (request.path === '/v1/sessions/shared/turns' || request.path === '/v1/sessions/other/turns') {
        const id = request.path.split('/')[3]!;
        return Response.json({ v: 1, sessionId: id, updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100,
            terminalAt: id === 'shared' ? 400 : 700, updatedAt: 900 },
        ] });
      }
      if (request.path === '/v1/sessions/shared/messages' || request.path === '/v1/sessions/other/messages') {
        return Response.json({ messages: [], hasMore: false });
      }
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: Object.fromEntries(
      ['shared', 'other'].map(id => [id, createSessionFixture({ id,
        serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' })]),
    ) });
    const store = getUsageQueryResourceStore(captured);
    const broad = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({
      period: { startMs: 0, endMs: 1000 },
    })] }) });
    const pinned = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({
      period: { startMs: 0, endMs: 1000 }, session: 'shared', metric: 'cost',
    })] }) });
    const countReads = (path: string) => home!.requests.filter(request => request.path === path).length;
    const ready = async (entry: typeof broad) => {
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      const content = entry.getSnapshot().value;
      expect(content).toBeDefined();
      return decodeUsageQueryResource(content!).results[0]!;
    };
    let releaseBroad = broad.subscribe(() => {}, true);
    const releasePinned = pinned.subscribe(() => {}, true);
    try {
      await expect.poll(() => countReads('/v2/sessions/other')).toBe(1);
      // Accounting request fanout is a different owner. Both consumers must
      // expose useful accounting while their shared private evidence is held.
      await expect.poll(() => [broad, pinned].every(entry => {
        const content = entry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results[0]?.accounting?.totals.eventCount === 1;
      })).toBe(true);
      await flushHookEffects({ cycles: 20 });
      expect(countReads('/v2/sessions/shared')).toBe(1);
      detailGate.resolve();
      const [all, selected] = await Promise.all([ready(broad), ready(pinned)]);
      // The witnessed 100ms approval wait is subtracted from each busy lane.
      expect(all.howYouWork?.intervals?.agentTimeMs).toBe(700);
      expect(selected.howYouWork?.intervals?.agentTimeMs).toBe(200);
      expect(countReads('/v1/sessions/shared/messages')).toBe(1);

      await pinned.refresh();
      expect((await ready(pinned)).howYouWork?.intervals?.agentTimeMs).toBe(200);
      expect(countReads('/v2/sessions/shared')).toBe(1);
      expect(countReads('/v1/sessions/shared/messages')).toBe(1);

      // A changed sequence starts one new shared operation. Detaching one
      // Resource cancels only its observation, preserving the other consumer.
      detailGate = createDeferred<void>();
      storage.setState({ sessions: { ...storage.getState().sessions,
        shared: { ...storage.getState().sessions.shared!, seq: 2 } } });
      const broadRefresh = broad.refresh();
      const pinnedRefresh = pinned.refresh();
      await expect.poll(() => countReads('/v2/sessions/shared')).toBe(2);
      await expect.poll(() => [broad, pinned].every(entry => entry.getSnapshot().pending !== 'idle')).toBe(true);
      await flushHookEffects({ cycles: 20 });
      releaseBroad();
      detailGate.resolve();
      await Promise.all([broadRefresh, pinnedRefresh]);
      expect((await ready(pinned)).howYouWork?.intervals?.agentTimeMs).toBe(200);
      expect(countReads('/v2/sessions/shared')).toBe(2);
      expect(countReads('/v1/sessions/shared/messages')).toBe(2);

      // A genuine Session wake fences the old producer before a refreshed
      // Resource can join it. Late old evidence cannot be labelled fresh.
      detailGate = createDeferred<void>();
      const staleGate = detailGate;
      storage.setState({ sessions: { ...storage.getState().sessions,
        shared: { ...storage.getState().sessions.shared!, seq: 3 } } });
      const staleRefresh = pinned.refresh();
      await expect.poll(() => countReads('/v2/sessions/shared')).toBe(3);
      detailGate = createDeferred<void>();
      storage.setState({ sessions: { ...storage.getState().sessions,
        shared: { ...storage.getState().sessions.shared!, seq: 4 } } });
      permissionCompletedAt = 600;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['shared'], {
        changeKinds: ['session'], usageQueryAffects: true,
      });
      staleGate.resolve();
      await expect.poll(() => countReads('/v2/sessions/shared')).toBe(4);
      detailGate.resolve();
      await staleRefresh;
      expect((await ready(pinned)).howYouWork?.permissions?.decisionLatencyMs).toBe(500);

      detailGate = createDeferred<void>();
      storage.setState({ sessions: { ...storage.getState().sessions,
        shared: { ...storage.getState().sessions.shared!, seq: 5 } } });
      releaseBroad = broad.subscribe(() => {}, true);
      const retiredRefresh = pinned.refresh();
      await expect.poll(() => countReads('/v2/sessions/shared')).toBe(5);
      retireActiveServerAccountScopeLifetime();
      detailGate.resolve();
      await retiredRefresh;
      expect(broad.getSnapshot().value).toBeUndefined();
      expect(pinned.getSnapshot().value).toBeUndefined();
    } finally {
      detailGate.resolve();
      releaseBroad();
      releasePinned();
    }
  });

  it('refreshes same-seq Session metadata through fresh admission while reusing opened input evidence', async () => {
    let completedAt = 200;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/work') return Response.json({ session: { ...ownerSessionAccess, id: 'work',
        createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0, metadataVersion: 1,
        metadata: JSON.stringify({ name: 'work' }), agentStateVersion: completedAt === 200 ? 1 : 2,
        agentState: JSON.stringify({ completedRequests: { request: { tool: 'Bash', turnId: 'turn',
          createdAt: 100, completedAt, status: 'approved' } } }), share: null } });
      if (request.path === '/v1/sessions/work/turns') return Response.json({ v: 1, sessionId: 'work', updatedAt: 900,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 }] });
      if (request.path === '/v1/sessions/work/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: {
      work: createSessionFixture({ id: 'work', serverId: captured.accountLifetime.scope.serverId }) } });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({
      session: 'work', period: { startMs: 0, endMs: 1000 } })] }) });
    const release = entry.subscribe(() => {}, true);
    const latency = () => entry.getSnapshot().value
      && decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork?.permissions?.decisionLatencyMs;
    try {
      await expect.poll(latency).toBe(100);
      completedAt = 600;
      storage.setState({ sessions: { work: { ...storage.getState().sessions.work!, agentStateVersion: 2 } } });
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['work'], { changeKinds: ['session'], usageQueryAffects: true });
      await expect.poll(latency).toBe(500);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(home!.requests.filter(request => request.path === '/v2/sessions/work')).toHaveLength(2);
      expect(home!.requests.filter(request => request.path === '/v1/sessions/work/messages')).toHaveLength(1);
    } finally { release(); }
  });

  it('batches equivalent resolved inputs and preserves distinct scopes as independent slices', async () => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    const query = normalizeUsageQuery({ agents: ['b', 'a'], period: { startMs: 1000, endMs: 2000 } });
    const equivalent = normalizeUsageQuery({ ...query, agents: ['a', 'b', 'a'] });
    const pinned = normalizeUsageQuery({ ...query, machines: ['machine-other'] });
    const result = await readUiUsageQueryBatch(captured, { queries: [query, equivalent, pinned] });
    expect(result.results).toHaveLength(2);
    expect(result.results.map(slice => slice.requestedQuery.machines).sort()).toEqual([[], ['machine-other']].sort());
    expect(result.results.every(slice => slice.accounting?.totals.tokens.total === 15)).toBe(true);
    expect(result.results[0]?.comparison?.accounting?.totals.tokens.total).toBe(15);
    const store = getUsageQueryResourceStore(captured);
    const first = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const second = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [equivalent] }) });
    const release = first.subscribe(() => {}, false);
    await first.refresh();
    expect(second.getSnapshot()).toBe(first.getSnapshot());
    release();
  });

  it('publishes available A while a producer is pending and advances only on its own Home wake', async () => {
    let pending = true;
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json({ ...value,
      coverage: { status: 'partial', reasons: [], sources: [{ source: 'native-history', path: 'native',
        status: pending ? 'pending' : 'available', eventCount: 1 }], missingDimensions: [],
        range: { complete: false }, ranked: [] },
    }) : undefined);
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{}] }) });
    const release = entry.subscribe(() => {}, true);
    try {
      await entry.refresh();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]).toMatchObject({
        accounting: value, sources: expect.arrayContaining([{ source: 'native-history', status: 'pending' }]), pending: true,
      });
      pending = false;
      publishHomeAccountChange('a-different-home');
      await flushHookEffects();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual({ source: 'native-history', status: 'pending' });
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['machine-a'], { usageQueryAffects: false });
      await flushHookEffects({ cycles: 20 });
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual({ source: 'native-history', status: 'pending' });
      // A material Machine-input change is still observed through the store,
      // even when the detailed page does not duplicate that invalidation.
      const machine = createMachineFixture({ id: 'usage-source-machine' });
      storage.setState({ machines: { [machine.id]: machine } });
      await flushHookEffects({ cycles: 20 });
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual({ source: 'native-history', status: 'available' });
      pending = true;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['session-a'], { usageQueryAffects: true });
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual({ source: 'native-history', status: 'pending' });
      pending = false;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId);
      await flushHookEffects({ cycles: 20 });
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual({ source: 'native-history', status: 'available' });
    } finally { release(); }
  });

  it('refuses a richer unsupported server read without falling back to an unfiltered legacy report', async () => {
    const captured = await context(request => request.path === '/v2/usage/query'
      ? Response.json({ error: 'not_found' }, { status: 404 })
      : request.path === '/v1/usage/query' ? Response.json({ usage: [] }) : undefined);
    const result = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ machines: ['specific'] })] });
    expect(result.results[0]?.accounting).toBeUndefined();
    expect(result.results[0]?.sources).toContainEqual({ source: 'accounting', status: 'error', errorCode: 'usage_query_failed' });
    expect(home!.requests.filter(request => request.path === '/v1/usage/query')).toEqual([]);
  });
});

describe('usage query Work composition', () => {
  it('exposes admitted SCM snapshots through the real accounting read without relabelling another query', async () => {
    const tokens = { input: 10, output: 5, total: 15, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    const contribution = { id: 'cost', observedAtMs: 150, sessionId: 'session', turnId: 'turn', agentId: null,
      modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null, tokens,
      cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-work.test', accountId: 'account-a' }],
      route: request => {
        if (request.path === '/v2/usage/query') return Response.json({ v: 1, totals: {
          eventCount: 1, tokens, cost: contribution.cost }, contributions: [{ ...contribution,
            ...(UsageAnalyticsQueryRequestSchema.parse(request.body).filters?.agentIds?.includes('different') ? { turnId: 'other-turn' } : {}) }] });
        if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        if (request.path === '/v2/sessions/session') return Response.json({ session: { ...ownerSessionAccess, id: 'session',
          createdAt: 1, updatedAt: 200, seq: 1, active: true, activeAt: 200, encryptionMode: 'plain',
          dataEncryptionKey: null, metadataLayoutVersion: 0, metadataVersion: 1,
          metadata: JSON.stringify({ name: 'work' }), agentStateVersion: 1, agentState: null, share: null } });
        if (request.path === '/v1/sessions/session/turns') return Response.json({ v: 1, sessionId: 'session', updatedAt: 200,
          turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 200, updatedAt: 200 }] });
        if (request.path === '/v1/sessions/session/messages') return Response.json({ messages: [], hasMore: false });
        return undefined;
      } });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    const context = captureUiUsageQueryAccountContext(credentials)!;
    storage.setState({ profileScope: context.accountLifetime.scope,
      profile: AccountProfileSchema.parse({ id: context.accountLifetime.scope.accountId }) });
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const other = normalizeUsageQuery({ ...query, agents: ['different'] });
    const workOnly = normalizeUsageQuery({ ...query, includeSessionEvidence: false, includeWorkEvidence: true });
    const accountingOnly = normalizeUsageQuery({ ...query, includeSessionEvidence: false, includeWorkEvidence: false });
    const witness: UsageWorkEvidence = { sessionId: 'session', turnId: 'turn', repositoryKey: 'repo',
      checkpointRef: 'checkpoint', checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
      attributionScope: 'no_happier_checkpoint_overlap_observed', pullRequest: {
        provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
          nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
        number: 1, title: 'Work', url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature', state: 'open' } };
    storage.getState().applySessions([createSessionFixture({ id: 'session', active: true,
      serverId: context.accountLifetime.scope.serverId, metadata: {
        machineId: 'work-machine', path: '/repo', host: 'test', homeDir: '/home/test',
      } })]);
    storage.getState().applyMachines([createMachineFixture({ id: 'work-machine' })]);
    scmTransport.mockImplementation(async (request: { payload: { state?: string } }) => ({ success: true,
      pullRequests: request.payload.state === 'open' ? [witness.pullRequest] : [],
      workEvidence: request.payload.state === 'open' ? [witness] : [], workEvidenceStatus: 'partial' }));
    const result = await readUiUsageQueryBatch(context, { queries: [query, other, workOnly, accountingOnly] });
    const accountingRequests = home.requests.filter(request => request.path === '/v2/usage/query');
    expect(accountingRequests.filter(request => {
      const input = UsageAnalyticsQueryRequestSchema.parse(request.body);
      return input.dateRange?.startMs === 100 && input.dateRange.endMs === 200
        && !input.filters?.agentIds?.length;
    })).toHaveLength(1);
    // Only the actual preceding range and distinct Agent filter add reads.
    expect(accountingRequests).toHaveLength(4);
    const relative = normalizeUsageQuery({ ...query, period: { relative: '7days' },
      includeSessionEvidence: false, includeWorkEvidence: false });
    let readClock = Date.UTC(2026, 9, 12, 12);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => readClock++);
    try {
      const start = home.requests.length;
      const relativeBatch = await readUiUsageQueryBatch(context, { queries: [relative,
        normalizeUsageQuery({ ...relative, includeSessionEvidence: true })] });
      expect(relativeBatch.results).toHaveLength(2);
      // One read clock resolves identical relative intent despite independent
      // projection work advancing the environment clock between consumers.
      // The current range and its preceding comparison are distinct reads;
      // evidence demand must not duplicate either one.
      const relativeRequests = home.requests.slice(start).filter(request => request.path === '/v2/usage/query');
      expect(relativeRequests).toHaveLength(2);
      const [currentPeriod, precedingPeriod] = relativeRequests.map(request => UsageAnalyticsQueryRequestSchema.parse(request.body).dateRange!);
      expect(currentPeriod.startMs).toBeDefined();
      expect(currentPeriod.endMs).toBeDefined();
      expect(precedingPeriod).toEqual({
        startMs: currentPeriod.startMs! - (currentPeriod.endMs! - currentPeriod.startMs!),
        endMs: currentPeriod.startMs,
      });
      for (const slice of relativeBatch.results) expect(slice.comparison?.query.period).toEqual(precedingPeriod);
    } finally { clock.mockRestore(); }
    const shown = result.results.find(slice => slice.key === getUsageQueryKey(query))!;
    expect(shown.work?.allocations).toMatchObject([{ reason: 'allocated', contribution, outcome: { repositoryKey: 'repo' } }]);
    expect(result.results.find(slice => slice.key === getUsageQueryKey(other))?.work?.allocations)
      .toMatchObject([{ reason: 'missing_evidence', outcome: null }]);
    expect(shown.sources).toContainEqual({ source: 'work', status: 'partial' });
    expect(shown.howYouWork?.intervals?.agentTimeMs).toBe(100);
    const workSlice = result.results.find(slice => slice.key === getUsageQueryKey(workOnly))!;
    expect(workSlice.work?.allocations[0]?.reason).toBe('allocated');
    expect(workSlice.howYouWork?.intervals).toBeNull();
    expect(workSlice.sources).toContainEqual({ source: 'how_you_work', status: 'not_loaded' });
    const accountingSlice = result.results.find(slice => slice.key === getUsageQueryKey(accountingOnly))!;
    expect(accountingSlice.accounting?.totals.tokens.total).toBe(15);
    expect(accountingSlice.work?.allocations[0]?.reason).toBe('missing_evidence');
    expect(accountingSlice.sources).toContainEqual({ source: 'work', status: 'not_loaded' });
    expect(home.requests.filter(request => request.path === '/v1/sessions/session/messages')).toHaveLength(1);
    const merged = { ...witness, pullRequest: { ...witness.pullRequest, state: 'merged' as const } };
    scmTransport.mockImplementation(async (request: { payload: { state?: string } }) => ({ success: true,
      pullRequests: request.payload.state === 'merged' ? [merged.pullRequest] : [],
      workEvidence: request.payload.state === 'merged' ? [merged] : [], workEvidenceStatus: 'partial' }));
    const native = await readUiUsageQueryBatch(context, { queries: [query] });
    expect(native.results[0]?.work?.allocations[0]).toMatchObject({ reason: 'allocated',
      outcome: { repositoryKey: 'repo', pullRequest: { state: 'merged' } } });
    const { pullRequest: _pullRequest, ...checkpoint } = witness;
    const branchWitness = { ...checkpoint, branch: { ref: 'refs/heads/standalone', headSha: 'b'.repeat(40) } };
    scmTransport.mockImplementation(async (request: { payload: { state?: string } }) => request.payload.state === undefined
      ? { success: true, branches: [], branchEvidence: [branchWitness], branchEvidenceStatus: 'partial' }
      : { success: true, pullRequests: [], workEvidence: [], workEvidenceStatus: 'partial' });
    const standalone = await readUiUsageQueryBatch(context, { queries: [query] });
    expect(standalone.results[0]?.work?.branchAllocations[0]).toMatchObject({ reason: 'allocated', contribution,
      branch: { repositoryKey: 'repo', branch: { ref: 'refs/heads/standalone' }, contributionIds: ['cost'] } });
    expect(standalone.results[0]?.work?.outcomes).toEqual([]);
    scmTransport.mockImplementation(async (request: { payload: { state?: string } }) => request.payload.state === 'closed'
      ? { success: false, errorCode: 'COMMAND_FAILED', error: 'Native hosting read failed' }
      : { success: true, pullRequests: [merged.pullRequest], workEvidence: [merged], workEvidenceStatus: 'partial' });
    const partial = await readUiUsageQueryBatch(context, { queries: [query] });
    expect(partial.results[0]?.sources).toContainEqual({ source: 'work', status: 'partial' });
    expect(partial.results[0]?.work?.allocations[0]?.reason).toBe('allocated');
    scmTransport.mockResolvedValue({ success: true, pullRequests: [witness.pullRequest] });
    const unsupported = await readUiUsageQueryBatch(context, { queries: [query] });
    expect(unsupported.results[0]?.sources).toContainEqual({ source: 'work', status: 'unsupported' });
    expect(unsupported.results[0]?.work?.allocations[0]).toMatchObject({ reason: 'missing_evidence', outcome: null, evidence: [] });
    scmTransport.mockImplementation(async (request: { payload: { state?: string } }) => request.payload.state === 'closed'
      ? { success: false, errorCode: 'INVALID_REQUEST', workEvidence: [merged] }
      : { success: true, pullRequests: [merged.pullRequest], workEvidence: [merged], workEvidenceStatus: 'partial' });
    const denied = await readUiUsageQueryBatch(context, { queries: [query] });
    expect(denied.results[0]?.work?.outcomes).toEqual([]);
    expect(denied.results[0]?.work?.allocations[0]?.evidence).toEqual([]);
    const detail = createDeferred<unknown>();
    scmTransport.mockImplementation(() => detail.promise);
    const store = getUsageQueryResourceStore(context);
    const entry = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const observed: Array<{ pending: boolean; accounting: boolean; allocated: boolean }> = [];
    const unsubscribe = entry.subscribe(() => {
      const value = entry.getSnapshot().value;
      if (!value) return;
      const slice = decodeUsageQueryResource(value).results[0]!;
      observed.push({ pending: slice.sources.some(source => source.source === 'work' && source.status === 'pending'),
        accounting: !!slice.accounting, allocated: slice.work?.allocations.some(row => row.reason === 'allocated') ?? false });
    }, true);
    await flushHookEffects({ cycles: 30 });
    expect(observed).toContainEqual({ pending: true, accounting: true, allocated: false });
    detail.resolve({ success: true, pullRequests: [witness.pullRequest], workEvidence: [witness], workEvidenceStatus: 'partial' });
    await flushHookEffects({ cycles: 30 });
    expect(observed.at(-1)).toEqual({ pending: false, accounting: true, allocated: true });
    unsubscribe();
    store.dispose();
    const retired = { ...context, accountLifetime: { ...context.accountLifetime, isCurrent: () => false } };
    await expect(readUiUsageQueryBatch(retired, { queries: [query] })).rejects.toMatchObject({ code: 'stale_surface' });
  });
});
