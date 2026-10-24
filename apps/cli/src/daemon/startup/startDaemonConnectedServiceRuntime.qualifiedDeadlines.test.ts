import { join } from 'node:path';
import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { QualifiedProviderAccountUsageWriteV4Schema, projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4,
  type QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol';
import type { RequesterConnectedAccountObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import { createBuiltInQualifiedRefreshHarness } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator.qualifiedRefresh.testkit';
import { createProviderAccountUsageStore } from '../connectedServices/accountUsage/store';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { observeConnectedServiceMaterializationPhase } from '../connectedServices/materialize/materializationPhase';
import { logger } from '@/utils/logger';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshotChanges } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { startDaemonConnectedServiceRuntime } from './startDaemonRuntimeBootstrap';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import type { TrackedSession } from '../types';

describe('qualified Connected Account deadline composition', () => {
  it.each(['both', 'health-only', 'quota-only'] as const)('prepares one initial pair for coincident health and quota despite nonoverlapping startup preparation (%s)', async mode => {
    const fixture = await createBuiltInQualifiedRefreshHarness();
    // Push delivery is a network boundary; the real bootstrap still owns
    // notification policy and quota acceptance callbacks.
    Object.assign(fixture.api, { push: () => ({ async sendToAllDevicesAsync() { return true; } }) });
    let resolveHealth!: () => void;
    const healthSettled = new Promise<void>(resolve => { resolveHealth = resolve; });
    const healthWrites: unknown[] = [];
    const quotaWrites: ReturnType<typeof QualifiedProviderAccountUsageWriteV4Schema.parse>[] = [];
    let manualRefreshRequestedAt: number | undefined;
    const invalidations = new Set<(event?: RequesterConnectedAccountObservation) => void>();
    const profiles: QualifiedConnectedAccountProfileV4[] = [{ ref: fixture.account,
      status: 'connected', kind: 'oauth', expiresAt: null, authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned', credentialRevision: fixture.firstRevision,
      configurationReady: true, configurationRevision: null, scopes: [], providerIdentity: { accountId: 'work' } }];
    let listings = 0;
    const previousSettings = getActiveAccountSettingsSnapshot();
    let clock = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
      loadedAtMs: clock, settingsSecretsReadKeys: [] });
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.includes('/v4/connect/qualified/credential?')) return { status: 200, data: await fixture.readCredential() };
      if (url.includes('/v4/connect/qualified/quotas?')) {
        const latest = quotaWrites.at(-1);
        if (manualRefreshRequestedAt !== undefined && latest?.snapshot) return { status: 200, data: {
          ref: fixture.account, sourceResolution: { source: latest.source, recordId: latest.recordId,
            providerAccountId: 'work', fetchedAt: latest.snapshot.fetchedAtMs, staleAfterMs: latest.snapshot.staleAfterMs },
          content: { t: 'plain', v: projectProviderAccountUsageSnapshotToQualifiedConnectedAccountQuotaSnapshotV4({
            snapshot: latest.snapshot, ref: fixture.account }) },
          metadata: { fetchedAt: latest.snapshot.fetchedAtMs, staleAfterMs: latest.snapshot.staleAfterMs,
            status: 'ok', refreshRequestedAt: manualRefreshRequestedAt },
        } };
        return { status: 404, data: { error: 'not_found' } };
      }
      throw new Error(`Unexpected deadline HTTP read: ${new URL(url).pathname}`);
    });
    const health = vi.spyOn(axios, 'patch').mockImplementation(async (url: string, body: unknown) => {
      if (!url.includes('/credential/health')) throw new Error('Unexpected health HTTP mutation');
      healthWrites.push(body); resolveHealth();
      return { status: 200, data: { success: true, credentialRevision: fixture.firstRevision, configurationRevision: null } };
    });
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (url: string, body: unknown) => {
      if (url.includes('/provider-account-usage')) quotaWrites.push(QualifiedProviderAccountUsageWriteV4Schema.parse(body));
      else throw new Error(`Unexpected deadline HTTP write: ${new URL(url).pathname}`);
      return { status: 200, data: { success: true } };
    });
    const requests = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('/v1/features')
      ? Response.json(FeaturesResponseSchema.parse({ features: { connectedServices: { enabled: true, quotas: { enabled: true } } }, capabilities: {} }))
      : Response.json({ rate_limit: { primary_window: { used_percent: 25, reset_at: Math.trunc(Date.now() / 1000) + 3600,
        limit_window_seconds: 18_000 } } }));
    const phases = vi.spyOn(logger, 'infoFile');
    const registry = new ConnectedServiceRuntimeRegistry();
    const trackedSessions = new Map<number, TrackedSession>();
    let control: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | undefined;
    let runtime: Awaited<ReturnType<typeof startDaemonConnectedServiceRuntime>> | undefined;
    try {
      control = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: fixture.happyHomeDir,
        activeServerDir: join(fixture.happyHomeDir, 'active'), serverId: 'deadline-home',
        serverHttpBaseUrl: 'https://deadline-home.test', machineId: 'machine', custodianAccountId: 'account',
        credentials: fixture.credentials, connectedServicesMaterializationBaseDir: join(fixture.happyHomeDir, 'materialized'),
        registry, trackedSessions, getRequester: () => null, resolveQualifiedConnectedAccountV4Support: () => 'advertised' });
      await observeConnectedServiceMaterializationPhase({ agentId: 'codex', materializationKey: 'coincident-deadline' },
        'credential_refresh', async () => {
          runtime = await startDaemonConnectedServiceRuntime({ api: fixture.api, credentials: fixture.credentials,
            machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime',
            happyHomeDir: fixture.happyHomeDir, activeServerDir: join(fixture.happyHomeDir, 'active'),
            logger: { debug() {}, info() {}, warn() {} }, processEnv: {
              HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: mode === 'quota-only' ? 'false' : 'true',
              ...(mode === 'health-only' ? { HAPPIER_BUILD_FEATURES_DENY: 'connectedServices.quotas' } : {}),
            },
            pidToTrackedSession: trackedSessions, connectedServiceQuotaFetcherDescriptors: [],
            connectedServiceRuntimeRegistry: registry,
            connectedServiceAuthGroupPreTurnSwitchCoordinator: control!.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator,
            connectedServiceRuntimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            providerAccountUsageStore: createProviderAccountUsageStore(),
            qualifiedConnectedAccountEstablishedRuntimeOwner: fixture.establishedRuntimeOwner,
            resolveQualifiedConnectedAccountPeerClass: () => 'advertised_v4',
            subscribeConnectedAccountInvalidations(listener) { invalidations.add(listener); return () => { invalidations.delete(listener); }; },
            // The incumbent startup starts health before quota hydration. Hold its
            // second listing until health has settled, so pending-only sharing fails.
            listScheduledQualifiedConnectedAccounts: async () => {
              if (++listings === 2) await healthSettled;
              return profiles;
            },
            accountSettingsSnapshot: getActiveAccountSettingsSnapshot,
            subscribeAccountSettingsSnapshot: listener => subscribeActiveAccountSettingsSnapshotChanges(listener),
          });
          expect(runtime.connectedServiceQuotasLoopHandle === null).toBe(mode === 'health-only');
          await vi.waitFor(() => {
            expect(healthWrites).toHaveLength(mode === 'quota-only' ? 0 : 1);
            if (mode !== 'health-only') expect(quotaWrites.some(write => (write.snapshot?.meters.length ?? 0) > 0)).toBe(true);
          });
        });
      const initialPreparations = phases.mock.calls.filter(([message, detail]) => message === '[CONNECTED ACCOUNT] Materialization phase'
        && typeof detail === 'object' && detail !== null && 'phase' in detail && detail.phase === 'established_snapshots'
        && 'status' in detail && detail.status === 'started');
      expect(initialPreparations).toHaveLength(1);
      // The optimization is not permission to reuse material at effect boundaries.
      expect(fixture.readCredential.mock.calls.length).toBeGreaterThan(1);
      if (mode === 'both') {
        const idleReads = reads.mock.calls.length;
        const idleCredentialReads = fixture.readCredential.mock.calls.length;
        const idleProviderReads = requests.mock.calls.length;
        clock += 61_000;
        // K scheduler demands with unchanged health/quota authority must not
        // reacquire material or poll the provider before its real deadline.
        for (let tick = 0; tick < 25; tick++) {
          vi.setSystemTime(clock++);
          expect((await runtime!.connectedServiceQuotasCoordinator!.tickOnce()).nextAutomaticRunAfterMs).toBeGreaterThan(60_000);
        }
        expect(reads).toHaveBeenCalledTimes(idleReads);
        expect(fixture.readCredential).toHaveBeenCalledTimes(idleCredentialReads);
        expect(requests).toHaveBeenCalledTimes(idleProviderReads);
        const beforeRefresh = quotaWrites.length;
        const latest = quotaWrites.at(-1);
        if (!latest?.snapshot) throw new Error('Expected the completed quota observation');
        manualRefreshRequestedAt = latest.snapshot.fetchedAtMs + 1;
        for (const listener of invalidations) listener({ quotaRefreshRecordIds: [latest.recordId] });
        await vi.waitFor(() => expect(reads.mock.calls.filter(([url]) => typeof url === 'string'
          && url.includes('/v4/connect/qualified/quotas?')).length).toBeGreaterThan(1));
        await vi.waitFor(() => expect(quotaWrites.length).toBeGreaterThan(beforeRefresh));
        expect(healthWrites).toHaveLength(1);
        const beforeOptIn = requests.mock.calls.length;
        clock += 61_000;
        vi.setSystemTime(clock);
        // A real Account Settings publication, not a coordinator-private wake,
        // makes an opted-in background notification an observation consumer.
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ usageQuotaNotificationsV1: { pace: true } }),
          settingsVersion: 2, loadedAtMs: clock, settingsSecretsReadKeys: [] });
        await vi.waitFor(() => expect(requests.mock.calls.length).toBeGreaterThan(beforeOptIn));
        expect(healthWrites).toHaveLength(1);
      }
    } finally {
      await runtime?.connectedServiceRefreshLoopHandle?.stop();
      await runtime?.connectedServiceQuotasLoopHandle?.stop();
      expect(invalidations.size).toBe(0);
      const stoppedReads = reads.mock.calls.length;
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 3,
        loadedAtMs: clock, settingsSecretsReadKeys: [] });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(reads).toHaveBeenCalledTimes(stoppedReads);
      phases.mockRestore(); requests.mockRestore(); writes.mockRestore(); health.mockRestore(); reads.mockRestore();
      vi.useRealTimers();
      if (previousSettings) setActiveAccountSettingsSnapshot(previousSettings); else clearActiveAccountSettingsSnapshot();
      await control?.dispose();
      await fixture.dispose();
    }
  });
});
