import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import type { MemoryIndexerConnection, MemoryIndexerHost, MemoryIndexerSnapshot } from './memoryIndexerBoundary';
import type { SessionListPageV1 } from '@/session/transport/http/sessionsHttp';
import type { MemorySettingsV1 } from '@/settings/memorySettings';

// Transform the source host graph outside the operation's deadline.
await import('./memoryWorker');

function deferred() {
  let resolved = false;
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = () => { resolved = true; done(); }; });
  return { promise, resolve, get resolved() { return resolved; } };
}

describe('Memory daemon/indexer boundary', () => {
  const env = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  let home: string;
  let readInventory: (url: URL) => SessionListPageV1;
  const workers: { stop(): void | Promise<void> }[] = [];
  beforeEach(async () => {
    home = await createTempDir('memory-indexer-boundary-');
    applyEnvValues({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://api.example.test', HAPPIER_WEBAPP_URL: 'https://app.example.test' });
    vi.useRealTimers();
    vi.resetModules();
    readInventory = () => ({ sessions: [], hasNext: false, nextCursor: null });
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200, data: readInventory(new URL(String(url))) };
      throw new Error(`Unexpected boundary fixture HTTP path: ${path}`);
    });
  });
  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.stop();
    vi.useRealTimers();
    restoreEnvValues(env);
    vi.restoreAllMocks();
    vi.resetModules();
    await removeTempDir(home);
  });

  async function setup(overrides: Partial<MemoryIndexerConnection> = {}, beforeConnect?: () => Promise<void>) {
    const { DEFAULT_MEMORY_SETTINGS, writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    let saved = await writeMemorySettingsToDisk({ ...DEFAULT_MEMORY_SETTINGS, enabled: false, deleteOnDisable: false });
    let host!: MemoryIndexerHost;
    const requests: string[] = [];
    // This is the child transport boundary, not a replacement for indexer logic.
    const connection: MemoryIndexerConnection = {
      applySettings: async settings => { saved = settings; publish(); },
      inventory: async () => {}, tick: async () => {}, refresh: async () => {}, revise: async () => {},
      removeSessions: async ids => { requests.push(`purge:${ids.join(',')}`); },
      reconcileAccess: async () => {}, archive: async () => {},
      readExternalPage: async () => null, embedQuery: async () => null,
      indexDocuments: async () => {}, retryEmbeddings: async () => {}, retire: async () => {},
      ...overrides,
    };
    const publish = (state: 'idle' | 'indexing' | 'error' = 'idle', indexesQualified = false, editedSessionIds: readonly string[] = [], extra: Partial<MemoryIndexerSnapshot> = {}) => host.publish({ settings: saved,
      embeddings: { mode: 'disabled', presetId: null, providerKind: null, modelId: null, runtimeState: 'unavailable', usingFallback: false, lastError: null },
      worker: { state, lastTickAtMs: null, lastInventoryAtMs: null, currentSessionId: null, currentPhase: null },
      indexesQualified, candidateSessionIds: ['pending'], observedSeqBySessionId: [], editedSessionIds, externalSources: [], ...extra });
    const connectIndexer = async (boundHost: MemoryIndexerHost) => {
      host = boundHost; requests.push('connect'); await beforeConnect?.(); publish(); return connection;
    };
    const { startMemoryWorker } = await import('./memoryWorker');
    const worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1',
      deps: { fetchDecryptedTranscriptPageAfterSeq: async () => [], connectIndexer } });
    workers.push(worker);
    return { worker, requests, publish, readExternalSources: (signal: AbortSignal) => host.readExternalSources(false, signal),
      observeSessions: (ids: readonly string[]) => host.observeSessions(ids), enable: async (changes: Partial<MemorySettingsV1> = {}) => {
      await writeMemorySettingsToDisk({ ...saved, ...changes, enabled: true });
      await worker.reloadSettings();
    } };
  }

  it('makes no child demands during fifteen settled enabled minutes or unchanged settings reloads', async () => {
    const demands: string[] = [];
    const { worker, enable } = await setup({
      applySettings: async () => { demands.push('settings'); },
      inventory: async () => { demands.push('inventory'); },
      tick: async () => { demands.push('tick'); },
    });
    const { configuration } = await import('@/configuration');
    const previous = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await enable();
      await vi.advanceTimersByTimeAsync(0);
      demands.length = 0;
      await worker.reloadSettings();
      await worker.reloadSettings();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(demands).toEqual([]);
    } finally { await worker.stop(); Object.assign(configuration, { isDaemonProcess: previous }); }
  });

  it('starts work once at the actual scheduler deadline and consumes a real wake after settling', async () => {
    let ticks = 0;
    let settled!: () => void;
    let consumeSources!: (signal: AbortSignal) => Promise<unknown>;
    const { worker, enable, publish, readExternalSources } = await setup({ tick: async signal => {
      ticks++;
      // A real child acknowledges its admitted source preparation before
      // publishing settlement. Keep this transport fixture faithful too.
      await consumeSources(signal ?? new AbortController().signal);
      settled();
    } });
    consumeSources = readExternalSources;
    settled = () => publish('idle', false, [], { nextWorkAtMs: null });
    const { configuration } = await import('@/configuration');
    const previous = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await enable();
      await vi.advanceTimersByTimeAsync(0);
      ticks = 0;
      publish('idle', false, [], { nextWorkAtMs: Date.now() + 91_023 });
      await vi.advanceTimersByTimeAsync(91_022);
      expect(ticks).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(ticks).toBe(1);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(ticks).toBe(1);
      // Revisions are a real external fact, even with no periodic tick armed.
      await worker.noteSessionTranscriptRevised!({ sessionId: 'pending', seq: 2 });
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks).toBe(2);
    } finally { await worker.stop(); Object.assign(configuration, { isDaemonProcess: previous }); }
  });

  it('does not demand a follow-up child for a topology wake consumed by the current run', async () => {
    const entered = deferred();
    const release = deferred();
    let ticks = 0;
    let consume!: (signal: AbortSignal) => Promise<unknown>;
    const { worker, enable, readExternalSources } = await setup({ tick: async signal => {
      ticks++;
      if (ticks === 1) { entered.resolve(); await release.promise; }
      await consume(signal ?? new AbortController().signal);
    } });
    consume = readExternalSources;
    const { configuration } = await import('@/configuration');
    const previous = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await enable();
      await entered.promise;
      const detach = worker.attachExternalObservation!({ registerAccountingSource: async () => {
        throw new Error('No native Agent is opted into this topology fixture');
      } });
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(ticks).toBe(1);
      detach();
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks).toBe(2);
      const { setActiveAccountSettingsSnapshot } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
      const { accountSettingsParse } = await import('@happier-dev/protocol');
      setActiveAccountSettingsSnapshot({ source: 'cache', settings: accountSettingsParse({}), settingsVersion: 1,
        loadedAtMs: Date.now(), settingsSecretsReadKeys: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks).toBe(3);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(ticks).toBe(3);
    } finally {
      release.resolve(); await worker.stop(); Object.assign(configuration, { isDaemonProcess: previous });
      const { resetActiveAccountSettingsSnapshotForTests } = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
      resetActiveAccountSettingsSnapshotForTests();
    }
  });

  it.each(['new_only', 'all_history'] as const)('observes eligible appends without demanding children for metadata or other machines (%s)', async backfillPolicy => {
    const { createSessionRecordFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const session = createSessionRecordFixture({ id: 'observed', seq: 4, createdAt: 500, updatedAt: 3000,
      encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) });
    const foreign = { ...session, id: 'foreign', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_2' })) };
    // The eligible Session lives beyond the head page, including when it
    // predates enablement but has current activity under new_only.
    readInventory = url => url.searchParams.has('cursor')
      ? { sessions: [session], hasNext: false, nextCursor: null }
      : { sessions: [foreign], hasNext: true, nextCursor: 'older' };
    let inventoryDemands = 0;
    let settle!: () => void;
    const { worker, enable, publish } = await setup({ inventory: async () => { inventoryDemands++; settle(); } });
    settle = () => publish('idle', false, [], { observedSeqBySessionId: [[session.id, session.seq]], nextWorkAtMs: null });
    const { configuration } = await import('@/configuration');
    const previous = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await enable({ backfillPolicy, enabledAtMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      settle();
      inventoryDemands = 0;
      session.updatedAt++;
      foreign.seq++;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(inventoryDemands).toBe(0);
      session.seq++;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(inventoryDemands).toBe(1);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(inventoryDemands).toBe(1);
    } finally { await worker.stop(); Object.assign(configuration, { isDaemonProcess: previous }); }
  });

  it('starts an absent indexer and joins its purge before acknowledging removal', async () => {
    const purge = deferred();
    const entered = deferred();
    const { worker, requests } = await setup({ removeSessions: async () => { entered.resolve(); await purge.promise; } });
    expect(requests).toEqual([]);
    let acknowledged = false;
    const removal = worker.removeSessions(['removed']).then(() => { acknowledged = true; });
    try {
      await vi.waitFor(() => expect(requests).toContain('connect'));
      await entered.promise;
      expect(acknowledged).toBe(false);
    } finally { purge.resolve(); await removal; }
    expect(acknowledged).toBe(true);
  });

  it('waits for terminal writer acknowledgement before removing DB/WAL/SHM and restores saved settings', async () => {
    const terminal = deferred();
    const retiring = deferred();
    const { worker, enable } = await setup({ retire: async () => { retiring.resolve(); await terminal.promise; } });
    await enable();
    const dbPath = worker.getTier1DbPhysicalPath!();
    await writeFile(dbPath, 'writer-owned');
    const clearing = worker.clearIndex();
    try {
      await vi.waitFor(() => expect(retiring.resolved).toBe(true));
      expect(existsSync(dbPath)).toBe(true);
    } finally { terminal.resolve(); await clearing; }
    expect(existsSync(dbPath)).toBe(false);
    const { readMemorySettingsFromDisk } = await import('@/settings/memorySettings');
    expect((await readMemorySettingsFromDisk()).enabled).toBe(true);
  });

  it('retires a connection still starting before clear completes and never reuses that retired transport', async () => {
    const connecting = deferred();
    const release = deferred();
    let retired = 0;
    const { worker, requests } = await setup({ retire: async () => { retired += 1; } }, async () => {
      connecting.resolve(); await release.promise;
    });
    const first = worker.removeSessions(['before-disable']).catch(error => error);
    await connecting.promise;
    const clearing = worker.clearIndex();
    // clearIndex enters its serialized retire before any filesystem removal.
    await new Promise<void>(resolve => setImmediate(resolve));
    release.resolve();
    await Promise.all([first, clearing]);
    expect(retired).toBe(1);
    await worker.removeSessions(['after-disable']);
    expect(requests.filter(request => request === 'connect')).toHaveLength(2);
  });

  it('passes refresh cancellation through the child transport and returns its cancellation', async () => {
    const entered = deferred();
    const { worker, enable } = await setup({ refresh: async (_id, signal) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    } });
    await enable();
    const controller = new AbortController();
    const cancelled = new Error('refresh_cancelled');
    const refresh = worker.ensureUpToDate('selected', controller.signal);
    const outcome = refresh.then(() => null, error => error);
    try { await vi.waitFor(() => expect(entered.resolved).toBe(true)); }
    finally { controller.abort(cancelled); }
    expect(await outcome).toBe(cancelled);
  });

  it('retains a visible failure after a child crashes instead of projecting completed coverage', async () => {
    const crash = Object.assign(new Error('child exited unexpectedly'), { code: 'background_service_failed' });
    const { worker, requests, enable, publish } = await setup({ refresh: async () => { throw crash; } });
    await enable();
    expect(requests).toContain('connect');
    publish('indexing');
    await expect(worker.ensureUpToDate()).rejects.toBe(crash);
    expect(worker.getWorkerStatus().state).toBe('error');
    expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: 'pending' }, state: 'error' });
  });

  it('re-admits retained snapshot validation after an observed refresh is cancelled', async () => {
    const entered = deferred();
    const seen: (readonly string[])[] = [];
    let observe!: (ids: readonly string[]) => Promise<readonly string[]>;
    const { worker, enable, observeSessions } = await setup({ refresh: async (_id, signal) => {
      seen.push(await observe(['retained']));
      if (seen.length > 1) return;
      entered.resolve();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    } });
    observe = observeSessions;
    await enable();
    const controller = new AbortController();
    const refresh = worker.ensureUpToDate('retained', controller.signal).catch(error => error);
    await entered.promise;
    controller.abort();
    await refresh;
    await worker.ensureUpToDate('retained');
    expect(seen).toEqual([['retained'], ['retained']]);
  });

  it('withdraws prior-policy search readers and reports failure if the replacement child cannot start', async () => {
    let starts = 0;
    const startupFailure = new Error('process_start_failed');
    const { worker, enable, publish } = await setup({}, async () => { if (++starts > 1) throw startupFailure; });
    await enable();
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    openSummaryShardIndexDb({ dbPath: worker.getTier1DbPhysicalPath!() }).close();
    publish('idle', true);
    expect(worker.getTier1DbPath()).toBe(worker.getTier1DbPhysicalPath!());
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    const prior = worker.getSettings();
    await writeMemorySettingsToDisk({ ...prior,
      contentPolicy: { ...prior.contentPolicy, includeReasoning: !prior.contentPolicy.includeReasoning } });
    await expect(worker.reloadSettings()).rejects.toBe(startupFailure);
    expect(worker.getTier1DbPath()).toBeNull();
    expect(worker.getWorkerStatus().state).toBe('error');
  });

  it('keeps a deferred revision pending across a query-only child snapshot until its later completion', async () => {
    let deferred = true;
    let revisionRequests = 0;
    let send!: () => void;
    const { worker, enable, publish } = await setup({ revise: async () => { revisionRequests += 1; send(); } });
    send = () => publish('idle', true, deferred ? ['pending'] : []);
    await enable();
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const db = openSummaryShardIndexDb({ dbPath: worker.getTier1DbPhysicalPath!() });
    try { db.recordMemorySessionIndexState({ sessionId: 'pending', status: 'indexed', updatedAtMs: 1 }); }
    finally { db.close(); }
    publish('idle', true);
    await worker.noteSessionTranscriptRevised!({ sessionId: 'pending', seq: 1 });
    expect(revisionRequests).toBe(0);
    await worker.ensureUpToDate('pending');
    // A query-only occurrence has no local dirty set; the daemon owns the
    // deferred fact until a source run positively completes it.
    publish('idle', true);
    expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: 'pending' }, state: 'indexing' });
    expect(revisionRequests).toBe(1);
    deferred = false;
    await worker.ensureUpToDate('pending');
    expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: 'pending' }, state: 'ready' });
  });
});
