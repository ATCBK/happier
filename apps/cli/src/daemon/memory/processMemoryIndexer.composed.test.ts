import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testkit/env/envSnapshot';
import { runBackgroundServiceProcessWorker } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessWorkerEntry';
import type { BackgroundServiceProcessChannel } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessChannel';
import type { TerminationEvent } from '@/subprocess/supervision/types';
import type { MemoryHintCommit, MemoryHintRun, MemoryIndexerConnection, MemoryIndexerHost, MemoryIndexerSnapshot } from './memoryIndexerBoundary';
import type { MemorySettingsV1 } from '@/settings/memorySettings';
import type { BackgroundServiceProcessPluginHost } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessBootstrap';
import type { AdmittedBackgroundServicePlugin } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessSource';

// Transform the real child graph outside each operation's deadline.
await import('./processMemoryIndexer');
await import('./memoryIndexerServiceEntry');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Only the OS pipe/process is replaced; both framed peers, entry and engine stay real. */
function createProcessBoundary() {
  const children: { channel: BackgroundServiceProcessChannel; closed: boolean; crash(): void }[] = [];
  const readers: Readonly<{ agentId: string; current: boolean; available: boolean }>[] = [];
  let beforeClose: (() => Promise<void>) | undefined;
  const spawnChannel = async (): Promise<BackgroundServiceProcessChannel> => {
    const parentListeners: ((data: Buffer) => void)[] = [];
    const childListeners: ((data: Buffer) => void)[] = [];
    const closeListeners: (() => void)[] = [];
    let finish!: (event: TerminationEvent) => void;
    const termination = new Promise<TerminationEvent>(done => { finish = done; });
    const deliver = (listeners: readonly ((data: Buffer) => void)[], frame: Buffer) => {
      for (const listener of listeners) { listener(frame.subarray(0, 3)); listener(frame.subarray(3)); }
    };
    const worker = runBackgroundServiceProcessWorker({
      onData: listener => { childListeners.push(listener); },
      onClose: listener => { closeListeners.push(listener); },
      write: frame => deliver(parentListeners, frame),
    }, { loadHostEntry: async () => ({ run: async (context, payload) => {
      for (const [agentId, runtime] of context.agentRuntimesByAgentId ?? []) readers.push({ agentId,
        current: runtime.isCurrent() && !runtime.retirementSignal.aborted, available: !!runtime.externalSessions });
      const { runMemoryIndexerService } = await import('./memoryIndexerServiceEntry');
      await runMemoryIndexerService(context, payload);
    } }) });
    const close = async () => {
      for (const listener of closeListeners) listener();
      await worker;
      await beforeClose?.();
      child.closed = true;
      finish({ type: 'exited', code: 0 });
    };
    const channel: BackgroundServiceProcessChannel = {
      pid: 43123 + children.length,
      send: frame => deliver(childListeners, frame),
      onData: listener => { parentListeners.push(listener); },
      waitForTermination: () => termination,
      close, terminate: close,
    };
    const child = { channel, closed: false, crash: () => {
      finish({ type: 'exited', code: 23 });
      for (const listener of closeListeners) listener();
    } };
    children.push(child);
    return channel;
  };
  return { children, readers, spawnChannel, holdClose() {
    const entered = deferred();
    const release = deferred();
    beforeClose = async () => { entered.resolve(); await release.promise; };
    return { entered: entered.promise, release: release.resolve };
  } };
}

describe('Memory process placement composition', () => {
  const env = snapshotEnvValues(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_LOG_LEVEL']);
  let home: string;
  const connections: MemoryIndexerConnection[] = [];
  beforeEach(async () => {
    home = await createTempDir('memory-process-composed-');
    applyEnvValues({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://api.example.test', HAPPIER_WEBAPP_URL: 'https://app.example.test' });
    vi.resetModules();
  });
  afterEach(async () => {
    for (const connection of connections.splice(0)) await connection.retire();
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreEnvValues(env);
    vi.resetModules();
    await removeTempDir(home);
  });

  async function setup(hostOverrides: Partial<MemoryIndexerHost> = {}, settingsOverrides: Partial<MemorySettingsV1> = {}, pluginOptions: Readonly<{
    plugins?: readonly AdmittedBackgroundServicePlugin[];
    pluginHost?: BackgroundServiceProcessPluginHost;
  }> = {}) {
    const boundary = createProcessBoundary();
    const snapshots: MemoryIndexerSnapshot[] = [];
    const failures: unknown[] = [];
    const settlements: boolean[] = [];
    const host: MemoryIndexerHost = {
      publish: snapshot => { snapshots.push(snapshot); },
      failed: error => { failures.push(error); },
      settled: () => { settlements.push(boundary.children.every(child => child.closed)); },
      readExternalSources: async () => ({ sources: [], configuredSourceKeys: [], changes: [] }),
      observeSessions: async ids => ids,
      runHint: async () => { throw new Error('Unexpected hint'); }, commitHint: async () => {},
      ...hostOverrides,
    };
    const { DEFAULT_MEMORY_SETTINGS } = await import('@/settings/memorySettings');
    const settings = { ...DEFAULT_MEMORY_SETTINGS, enabled: false, deleteOnDisable: false, ...settingsOverrides };
    const { connectProcessMemoryIndexer: connectIndexer } = await import('./processMemoryIndexer');
    const params = { credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1', host,
      readSettings: () => settings, spawnChannel: boundary.spawnChannel, ...pluginOptions };
    const connection = await connectIndexer(params);
    connections.push(connection);
    return { connection, boundary, snapshots, failures, settlements, settings };
  }

  it('starts no idle child, purges retained SQLite through the child, then rebirths after settlement', async () => {
    const { connection, boundary, settlements } = await setup();
    expect(boundary.children).toHaveLength(0);
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { tier1DbPath } = resolveMemoryIndexPaths();
    await mkdir(dirname(tier1DbPath), { recursive: true });
    const seed = openSummaryShardIndexDb({ dbPath: tier1DbPath });
    seed.insertSummaryShard({ sessionId: 'removed', seqFrom: 1, seqTo: 2, createdAtFromMs: 1, createdAtToMs: 2,
      summary: 'retained marker', keywords: [], entities: [], decisions: [], policyKey: 'fixture' });
    seed.close();
    await connection.removeSessions(['removed']);
    expect(boundary.children).toHaveLength(1);
    expect(boundary.children[0]?.closed).toBe(true);
    const retained = openSummaryShardIndexDb({ dbPath: tier1DbPath });
    try { expect(retained.listIndexedSessionIds()).not.toContain('removed'); }
    finally { retained.close(); }
    await connection.removeSessions(['absent']);
    expect(boundary.children).toHaveLength(2);
    expect(boundary.children.every(child => child.closed)).toBe(true);
    expect(settlements).toEqual([true, true]);
  });

  it('cancels one operation across the bridge while another demand still completes', async () => {
    const entered = deferred();
    let observationReads = 0;
    let operationAborted = false;
    const { connection, boundary, settings } = await setup({ readExternalSources: async (_refresh, signal) => {
      observationReads += 1;
      if (observationReads === 2) {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => { operationAborted = true; reject(signal.reason); };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      return { sources: [], configuredSourceKeys: [], changes: [] };
    } });
    const controller = new AbortController();
    const cancelled = connection.applySettings(settings, controller.signal).then(() => null, error => error);
    await entered.promise;
    const purge = connection.removeSessions(['absent']);
    controller.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    await purge;
    expect(operationAborted).toBe(true);
    expect(boundary.children).toHaveLength(1);
    expect(boundary.children[0]?.closed).toBe(true);
  });

  it.each(['command', 'scheduler continuation', 'global scheduler continuation'] as const)('lets a purge abort held HTTP transcript work in the %s phase before acknowledging process disposal', async phase => {
    const { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const session = createSessionRecordFixture({ id: 'removed-in-flight', seq: phase === 'command' ? 1 : 2, createdAt: 1, updatedAt: 2,
      encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) });
    const entered = deferred();
    const firstPageRead = deferred();
    let transcriptAborted = false;
    let heldAfterSeq: number | undefined;
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const request = new URL(String(url));
      const path = request.pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v2/sessions') return { status: 200, data: { sessions: [session], hasNext: false, nextCursor: null } };
      if (path === `/v2/sessions/${session.id}`) return { status: 200, data: { session } };
      if (path === `/v1/sessions/${session.id}/messages`) {
        const afterSeq = Number(request.searchParams.get('afterSeq'));
        if (phase !== 'command' && afterSeq === 0) {
          firstPageRead.resolve();
          return { status: 200, data: {
          messages: [{ id: 'first-page', seq: 1, createdAt: 1000, updatedAt: 1000, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'removed retained first page marker' } } } }],
          hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
          } };
        }
        heldAfterSeq = afterSeq;
        const signal = config?.signal;
        entered.resolve();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => { transcriptAborted = true; reject(new Error('fixture transcript aborted')); };
          signal?.addEventListener?.('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      throw new Error(`Unexpected purge HTTP fixture path: ${path}`);
    });
    const { connection, boundary, settlements } = await setup({ readExternalSources: async () => {
      await new Promise<void>(resolve => { setImmediate(resolve); });
      return { sources: [], configuredSourceKeys: [], changes: [] };
    } }, {
      enabled: true, indexMode: 'deep', backfillPolicy: 'all_history', coveragePolicy: { type: 'full' },
    });
    const refreshing = connection.refresh(phase === 'global scheduler continuation' ? undefined : session.id);
    // Observe rejection immediately too: retirement must clean up a failing RED.
    const refreshed = Promise.allSettled([refreshing]);
    if (phase === 'global scheduler continuation') {
      await firstPageRead.promise;
      await vi.waitFor(() => { expect(heldAfterSeq).toBe(1); });
    }
    await entered.promise;
    expect(heldAfterSeq).toBe(phase === 'command' ? 0 : 1);
    if (phase !== 'command') {
      const { openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
      const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
      const retained = openDeepIndexReader({ dbPath: resolveMemoryIndexPaths().deepDbPath });
      try { expect(retained.search({ query: 'removed', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1); }
      finally { retained.close(); }
    }
    const terminal = boundary.holdClose();
    const purged = Promise.allSettled([connection.removeSessions([session.id])]);
    let acknowledged = false;
    const completion = purged.then(result => { acknowledged = true; return result; });
    try {
      await vi.waitFor(() => { expect(transcriptAborted).toBe(true); });
      await terminal.entered;
      expect(acknowledged).toBe(false);
      terminal.release();
      expect(await refreshed).toMatchObject([{ status: 'fulfilled' }]);
      expect(await completion).toMatchObject([{ status: 'fulfilled' }]);
      expect(boundary.children).toHaveLength(1);
      expect(boundary.children[0]?.closed).toBe(true);
      expect(settlements).toEqual([true]);
      const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
      const { openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
      const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
      const paths = resolveMemoryIndexPaths();
      const summary = openSummaryShardIndexDb({ dbPath: paths.tier1DbPath });
      const deep = openDeepIndexReader({ dbPath: paths.deepDbPath });
      try {
        expect(summary.listIndexedSessionIds()).not.toContain(session.id);
        expect(deep.search({ query: 'removed', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      } finally { summary.close(); deep.close(); }
    } finally {
      terminal.release();
      await connection.retire();
      await Promise.all([refreshed, completion]);
    }
  });

  it('joins writer and physical process disposal during idempotent retirement', async () => {
    const entered = deferred();
    let aborted = false;
    const { connection, boundary } = await setup({ readExternalSources: async (_refresh, signal) => {
      entered.resolve();
      await new Promise<void>(resolve => {
        const abort = () => { aborted = true; resolve(); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      return { sources: [], configuredSourceKeys: [], changes: [] };
    } });
    const request = connection.removeSessions(['absent']).catch(error => error);
    await entered.promise;
    const terminal = boundary.holdClose();
    let retired = false;
    const first = connection.retire();
    const second = connection.retire();
    expect(second).toBe(first);
    const retiring = first.then(() => { retired = true; });
    await terminal.entered;
    expect(aborted).toBe(true);
    expect(retired).toBe(false);
    expect(boundary.children[0]?.closed).toBe(false);
    terminal.release();
    await retiring;
    expect(retired).toBe(true);
    expect(boundary.children[0]?.closed).toBe(true);
    await request;
    await expect(connection.removeSessions(['later'])).rejects.toThrow('memory_indexer_retired');
  });

  it('settles successive inventory children without rereading an unchanged full Session snapshot', async () => {
    const { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const session = createSessionRecordFixture({ id: 'unchanged-retained', seq: 1, createdAt: 1, updatedAt: 2,
      encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) });
    let transcriptReads = 0;
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const request = new URL(String(url));
      if (request.pathname === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (request.pathname === '/v2/sessions') return { status: 200, data: { sessions: [session], hasNext: false, nextCursor: null } };
      if (request.pathname === `/v2/sessions/${session.id}`) return { status: 200, data: { session } };
      if (request.pathname === `/v1/sessions/${session.id}/messages`) {
        transcriptReads += 1;
        return { status: 200, data: {
          messages: Number(request.searchParams.get('afterSeq')) === 0
            ? [{ id: 'retained-row', seq: 1, createdAt: 1000, updatedAt: 1000, messageRole: 'user',
              content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'unchanged retained snapshot marker' } } } }]
            : [],
          hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
        } };
      }
      throw new Error(`Unexpected retained inventory HTTP fixture path: ${request.pathname}`);
    });
    const observed = new Set<string>();
    const { connection, boundary } = await setup({
      observeSessions: async ids => {
        const fresh = ids.filter(id => !observed.has(id));
        for (const id of fresh) observed.add(id);
        return fresh;
      },
      // Match the asynchronous host observation boundary so a broken scheduler
      // remains cancellable by the ordinary test/lifecycle deadline.
      readExternalSources: async () => {
        await new Promise<void>(resolve => { setImmediate(resolve); });
        return { sources: [], configuredSourceKeys: [], changes: [] };
      },
    }, { enabled: true, indexMode: 'deep', backfillPolicy: 'all_history', coveragePolicy: { type: 'full' } });
    await connection.inventory();
    const initialReads = transcriptReads;
    expect(initialReads).toBeGreaterThan(0);
    expect(boundary.children).toHaveLength(1);
    expect(boundary.children[0]?.closed).toBe(true);
    const { openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const retained = openDeepIndexReader({ dbPath: resolveMemoryIndexPaths().deepDbPath });
    try { expect(retained.search({ query: 'unchanged', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1); }
    finally { retained.close(); }
    await connection.inventory();
    expect(transcriptReads).toBe(initialReads);
    expect(boundary.children).toHaveLength(2);
    expect(boundary.children.every(child => child.closed)).toBe(true);
  });

  it('admits the current inventory on a deadline tick in a fresh child and exits after indexing', async () => {
    const { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const session = createSessionRecordFixture({ id: 'deadline-source', seq: 1, createdAt: 1, updatedAt: 2,
      encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) });
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const request = new URL(String(url));
      if (request.pathname === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (request.pathname === '/v2/sessions') return { status: 200, data: { sessions: [session], hasNext: false, nextCursor: null } };
      if (request.pathname === `/v2/sessions/${session.id}`) return { status: 200, data: { session } };
      if (request.pathname === `/v1/sessions/${session.id}/messages`) return { status: 200, data: {
        messages: Number(request.searchParams.get('afterSeq')) === 0 ? [{ id: 'deadline-row', seq: 1,
          createdAt: 1000, updatedAt: 1000, messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'deadline searchable marker' } } } }] : [],
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      } };
      throw new Error(`Unexpected deadline HTTP fixture path: ${request.pathname}`);
    });
    const { connection, boundary } = await setup({}, { enabled: true, indexMode: 'deep',
      backfillPolicy: 'all_history', coveragePolicy: { type: 'full' } });
    await connection.tick();
    expect(boundary.children).toHaveLength(1);
    expect(boundary.children[0]?.closed).toBe(true);
    const { openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const retained = openDeepIndexReader({ dbPath: resolveMemoryIndexPaths().deepDbPath });
    try { expect(retained.search({ query: 'deadline', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1); }
    finally { retained.close(); }
  });

  it('births no child over fifteen settled minutes and exactly one for a real append through the daemon worker', async () => {
    applyEnvValues({ HAPPIER_LOG_LEVEL: 'silent' });
    const { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const session = createSessionRecordFixture({ id: 'demand-source', seq: 1, createdAt: 1, updatedAt: 2,
      encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) });
    let seq = 1;
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const request = new URL(String(url));
      if (request.pathname === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (request.pathname === '/v2/sessions') return { status: 200, data: { sessions: [{ ...session, seq }], hasNext: false, nextCursor: null } };
      if (request.pathname === `/v2/sessions/${session.id}`) return { status: 200, data: { session: { ...session, seq } } };
      if (request.pathname === `/v1/sessions/${session.id}/messages`) return { status: 200, data: {
        messages: Array.from({ length: seq }, (_, index) => ({ id: `demand-row-${index + 1}`, seq: index + 1,
          createdAt: 1000 + index, updatedAt: 1000 + index, messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: index ? 'appendmarker searchable' : 'initialmarker searchable' } } },
        })).filter(row => row.seq > Number(request.searchParams.get('afterSeq'))),
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      } };
      throw new Error(`Unexpected worker demand HTTP fixture path: ${request.pathname}`);
    });
    const { writeMemorySettingsToDisk, readMemorySettingsFromDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, deleteOnDisable: false, indexMode: 'deep',
      backfillPolicy: 'all_history', coveragePolicy: { type: 'full' }, deep: { minChunkMessages: 1 } });
    const { configuration } = await import('@/configuration');
    const priorDaemon = configuration.isDaemonProcess;
    Object.assign(configuration, { isDaemonProcess: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const boundary = createProcessBoundary();
    const { connectProcessMemoryIndexer } = await import('./processMemoryIndexer');
    const { startMemoryWorker } = await import('./memoryWorker');
    const worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1',
      deps: { connectIndexer: async host => {
        const settings = await readMemorySettingsFromDisk();
        return await connectProcessMemoryIndexer({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine_1',
          host, readSettings: () => settings, spawnChannel: boundary.spawnChannel });
      } } });
    try {
      await vi.waitFor(() => {
        expect(worker.getIndexSources?.()).toContainEqual({ source: { type: 'happier_session', sessionId: session.id }, state: 'ready' });
        expect(boundary.children.length).toBeGreaterThan(0);
        expect(boundary.children.every(child => child.closed)).toBe(true);
      });
      const births = boundary.children.length;
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(boundary.children).toHaveLength(births);
      seq = 2;
      await vi.advanceTimersByTimeAsync(worker.getSettings().worker.inventoryRefreshIntervalMs);
      await vi.waitFor(() => {
        expect(boundary.children).toHaveLength(births + 1);
        expect(boundary.children.every(child => child.closed)).toBe(true);
      });
      const { openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
      const retained = openDeepIndexReader({ dbPath: worker.getDeepDbPath()! });
      try { expect(retained.search({ query: 'appendmarker', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1); }
      finally { retained.close(); }
    } finally { await worker.stop(); Object.assign(configuration, { isDaemonProcess: priorDaemon }); vi.useRealTimers(); }
  });

  it('rejects an active demand on child death, reports failure, and starts fresh on later demand', async () => {
    const entered = deferred();
    let reads = 0;
    const { connection, boundary, failures, settlements } = await setup({ readExternalSources: async (_refresh, signal) => {
      if (++reads === 1) {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      return { sources: [], configuredSourceKeys: [], changes: [] };
    } });
    const request = connection.removeSessions(['absent']);
    const rejected = expect(request).rejects.toMatchObject({ code: 'background_service_process_exited' });
    await entered.promise;
    boundary.children[0]!.crash();
    await rejected;
    expect(failures).not.toHaveLength(0);
    expect(settlements).toEqual([]);
    await connection.removeSessions(['next']);
    expect(boundary.children).toHaveLength(2);
    expect(boundary.children[1]?.closed).toBe(true);
    expect(settlements).toEqual([true]);
  });

  it('returns query vectors over the strict bridge and never transports provider objects', async () => {
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push(String(url));
      expect(JSON.parse(String(init?.body))).toMatchObject({ input: 'selected query', model: 'fixture-model' });
      return new Response(JSON.stringify({ data: [{ embedding: [0.25, 0.5, 0.75] }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const { DEFAULT_MEMORY_SETTINGS } = await import('@/settings/memorySettings');
    const { connection, boundary } = await setup({}, { enabled: true, indexMode: 'deep', embeddings: {
      ...DEFAULT_MEMORY_SETTINGS.embeddings, mode: 'custom', custom: { kind: 'openai_compatible',
        baseUrl: 'https://embeddings.example.test/v1', model: 'fixture-model',
        apiKey: { _isSecretValue: true, value: 'fixture-key' },
      },
    } });
    expect(await connection.embedQuery('selected query')).toEqual([0.25, 0.5, 0.75]);
    expect(requests).toEqual(['https://embeddings.example.test/v1/embeddings']);
    expect(boundary.children).toHaveLength(1);
    expect(boundary.children[0]?.closed).toBe(true);
  });

  it('preserves native query ordinals and windows against the same in-process traversal', async () => {
    const { ingestCanonicalPluginManifest } = await import('@/plugins/manifest/ingest');
    const { bindPluginRuntimeSourceAuthority, resolvePluginSourceCustody } = await import('@/plugins/runtime/sourceAuthority');
    const { projectAdmittedBackgroundServicePlugin } = await import('@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessSource');
    const { createProductionPluginInvocationServiceOwners } = await import('@/plugins/runtime/invocation/services/production');
    const { DEFAULT_MEMORY_SETTINGS } = await import('@/settings/memorySettings');
    const { resolveBackgroundServiceProcessBootstrap } = await import('@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessBootstrap');
    const { createMemoryExternalTranscriptReader } = await import('./externalTranscriptSources');
    const { syncExternalMemoryTranscriptsBatch } = await import('./externalTranscriptIndex');
    const { openDeepIndexDb, openDeepIndexReader } = await import('./deepIndex/deepIndexDb');
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const pluginId = 'acme.memory-native-reader';
    const agentId = `${pluginId}/reader`;
    const occurrenceId = 'admitted-native-reader';
    const root = join(home, 'native-reader');
    const entryPath = join(root, 'daemon.mjs');
    const transcript = join(root, 'transcript.json');
    const inventoryMarker = join(root, 'unexpected-inventory');
    const activityAtMs = Date.now();
    await mkdir(root, { recursive: true });
    await writeFile(transcript, JSON.stringify({ items: [0, 1].map(ordinal => ({ id: `native-row-${ordinal}`, createdAtMs: activityAtMs + ordinal,
      messageRole: 'user', userProjection: 'source_fact', raw: { role: 'user', content: { type: 'text', text: `Native window marker ordinal${ordinal}` } },
    })), nextCursor: null }));
    await writeFile(entryPath, `
      import { readFile, writeFile } from 'node:fs/promises';
      export function activate(api) {
        api.agents.registerExternalSessions('reader', {
          async resolveSource(request) { return { ok: true, value: { source: request.source } }; },
          async resolveLinkIdentity(request) { return { ok: true, value: { source: request.source, remoteSessionId: request.remoteSessionId, linkData: {} } }; },
          async resolveLinkedIdentity(request) { return { ok: true, value: { source: request.source, remoteSessionId: request.remoteSessionId, linkData: request.linkData } }; },
          async listCandidates() { await writeFile(${JSON.stringify(inventoryMarker)}, 'started'); return { ok: true, value: { candidates: [{ remoteSessionId: 'native-1', updatedAtMs: ${activityAtMs} }], nextCursor: null } }; },
          async pageTranscript() { return { ok: true, value: JSON.parse(await readFile(${JSON.stringify(transcript)}, 'utf8')) }; },
          async readAfterTranscript() { return { ok: true, value: { outcome: 'already_current' } }; },
        });
      }
    `);
    const parsed = ingestCanonicalPluginManifest({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Memory native fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
      contributes: { agents: [{ id: 'reader', title: 'Native fixture', capabilities: { surfaces: ['externalSessions'] },
        surfaces: { externalSession: { sources: [{ sourceKind: 'nativeFixture',
          schema: { fields: [{ name: 'kind', kind: 'literal', value: 'nativeFixture' }] },
          key: { segments: [{ kind: 'literal', value: 'nativeFixture' }] }, instances: [{ kind: 'default', constants: {} }],
        }] } },
      }] },
    }, { sourceProvenance: 'registryCustodied' });
    if (!parsed.ok) throw new Error(parsed.diagnostics.map(item => item.message).join('\n'));
    const sourceAuthority = bindPluginRuntimeSourceAuthority({ custody: { kind: 'development', registeredRootId: root }, resolvedRoot: root, observedRevision: 1 });
    const admitted = projectAdmittedBackgroundServicePlugin({
      target: { provenance: 'external', source: { kind: 'path' }, pluginId,
        manifestPath: join(root, 'plugin.json'), daemonEntryPath: entryPath,
        sourceSpec: { kind: 'path', locator: root, trustPolicy: 'local_trusted', installPolicy: 'link' }, manifest: parsed.manifest },
      occurrenceId, sourceCustody: resolvePluginSourceCustody(sourceAuthority), source: { kind: 'file_backed', sourceAuthority, entryPath },
    });
    const services = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
    const lifetime = new AbortController();
    const pluginHost: BackgroundServiceProcessPluginHost = { prepareAgentInvocationServices: request => services.prepareBackgroundServiceProcessOperationServices({
      plugin: { id: request.pluginId, version: request.pluginVersion }, contribution: { id: 'reader', qualifiedId: `${pluginId}/agents/reader` },
      occurrenceId: request.occurrenceId, correlationId: request.correlationId, surface: 'agent', signal: request.signal,
      isOccurrenceCurrent: () => !lifetime.signal.aborted,
    }, { hostAccessRequests: [], filesystemRoots: { pluginData: root, workspace: root, projects: new Map() } }) };
    const sourceSnapshot = {
      sources: [{ agentId, sourceKey: 'nativeFixture', source: { kind: 'nativeFixture' }, occurrenceId }],
      configuredSourceKeys: [JSON.stringify([agentId, 'nativeFixture'])], changes: [],
    };
    const request = { source: { type: 'external_transcript' as const, agentId, sourceKey: 'nativeFixture', nativeSessionId: 'native-1' } };
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v2/sessions') return { status: 200, data: { sessions: [], hasNext: false, nextCursor: null } };
      throw new Error(`Unexpected native comparison HTTP path: ${path}`);
    });
    try {
      const { connection, boundary, settings } = await setup({ readExternalSources: async () => sourceSnapshot }, {
        enabled: true, indexMode: 'deep', deep: { ...DEFAULT_MEMORY_SETTINGS.deep, minChunkMessages: 1 },
        conversationSearch: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch,
        indexExternal: { ...DEFAULT_MEMORY_SETTINGS.conversationSearch.indexExternal, enabled: true, agents: [agentId] },
      } }, { plugins: [admitted], pluginHost });
      const page = await connection.readExternalPage(request);
      expect(boundary.readers).toContainEqual({ agentId, current: true, available: true });
      expect(page?.items.map(item => item.id)).toEqual(['native-row-0', 'native-row-1']);
      expect(existsSync(inventoryMarker)).toBe(false);
      expect(boundary.children).toHaveLength(1);
      expect(boundary.children[0]?.closed).toBe(true);
      await connection.tick();
      const query = { query: 'Native', scope: { type: 'global' as const }, maxResults: 10, includeExternal: true };
      const processDb = openDeepIndexReader({ dbPath: resolveMemoryIndexPaths().deepDbPath });
      const normalize = (hits: ReturnType<typeof processDb.search>) => hits.map(({ source, sourceItemId, seqFrom, seqTo, text }) => ({ source, sourceItemId, seqFrom, seqTo, text }));
      let processHits: ReturnType<typeof normalize>;
      try { processHits = normalize(processDb.search(query)); }
      finally { processDb.close(); }
      const baselineDb = openDeepIndexDb({ dbPath: join(home, 'in-process.sqlite') });
      const baseline = await resolveBackgroundServiceProcessBootstrap({ entry: 'host', entryId: 'memory-indexer', payload: null, plugins: [admitted] }, {
        loadHostEntry: async () => ({ run: async context => {
          const sources = createMemoryExternalTranscriptReader({ onChange() {}, resolveReader: async id => context.agentRuntimesByAgentId?.get(id)?.externalSessions ?? null });
          try {
            await sources.refresh(sourceSnapshot, settings, context.signal);
            await sources.inventory(context.signal);
            await syncExternalMemoryTranscriptsBatch({ candidates: sources.take(1), db: baselineDb, settings,
              nowMs: activityAtMs, signal: context.signal, onSourceResult: sources.noteSyncResult });
            expect(await sources.readPage(request, settings, context.signal)).toEqual(page);
          } finally { await sources.dispose(); }
        } }),
      });
      try {
        await baseline.run({ signal: lifetime.signal, services: { __backgroundServiceProcessPlugins: pluginHost } });
        expect(processHits).toHaveLength(2);
        expect(processHits).toEqual(normalize(baselineDb.search(query)));
      } finally { await baseline.dispose(); baselineDb.close(); }
    } finally { lifetime.abort(); await services.dispose(); }
  });

  it.each(['continuous', 'deadline admitted during settlement'] as const)('prepares hints in the child and delegates execution plus record commit to daemon-bound authorities (%s)', async mode => {
    if (mode !== 'continuous') {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(2000);
    }
    const { createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const { DEFAULT_MEMORY_SETTINGS } = await import('@/settings/memorySettings');
    const session = createSessionRecordFixture({ id: 'hint-session', seq: 1, createdAt: 1, updatedAt: 2,
      encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata({ machineId: 'machine_1' })) });
    const axios = (await import('axios')).default;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v2/sessions/hint-session') return { status: 200, data: { session } };
      if (path === '/v1/sessions/hint-session/messages') return { status: 200, data: {
        messages: [{ id: 'hint-row', seq: 1, createdAt: 1000, updatedAt: 1000, messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'bridge hint transcript marker' } } } }],
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      } };
      throw new Error(`Unexpected hint HTTP fixture path: ${path}`);
    });
    const executions: MemoryHintRun[] = [];
    const commits: MemoryHintCommit[] = [];
    const { connection } = await setup({
      publish: snapshot => {
        // Cross the real hint idle deadline while this same child is still
        // serving its admitted run, before its scheduler settles.
        if (mode !== 'continuous' && snapshot.nextWorkAtMs != null && snapshot.nextWorkAtMs > Date.now()) {
          vi.setSystemTime(snapshot.nextWorkAtMs);
        }
      },
      runHint: async request => {
        executions.push(request);
        return JSON.stringify({ shard: { v: 1, seqFrom: 0, seqTo: 0, createdAtFromMs: 0, createdAtToMs: 0,
          summary: 'Bridge generated summary', keywords: ['bridge'], entities: [], decisions: [],
        }, synopsis: { v: 1, seqTo: 0, updatedAtMs: 0, synopsis: 'Bridge generated synopsis' } });
      },
      commitHint: async request => { commits.push(request); },
    }, { enabled: true, indexMode: 'hints', backfillPolicy: 'all_history', coveragePolicy: { type: 'full' },
      hints: { ...DEFAULT_MEMORY_SETTINGS.hints, enabled: true, updateMode: mode === 'continuous' ? 'continuous' : 'onIdle', idleDelayMs: 5000,
        summarizerBackendId: 'fixture-agent', summarizerModelId: 'fixture-model', summarizerPermissionMode: 'read_only' },
    });
    await connection.refresh(session.id);
    expect(executions).toMatchObject([{ sessionId: session.id, backendId: 'fixture-agent', modelId: 'fixture-model', permissionMode: 'read_only' }]);
    expect(executions[0]?.prompt).toContain('bridge hint transcript marker');
    expect(commits).toMatchObject([{ sessionId: session.id,
      shardPayload: { summary: 'Bridge generated summary', seqFrom: 1, seqTo: 1 },
      synopsisPayload: { synopsis: 'Bridge generated synopsis', seqTo: 1 },
    }]);
    const { openSummaryShardIndexDb } = await import('./summaryShardIndexDb');
    const { resolveMemoryIndexPaths } = await import('./memoryIndexPaths');
    const reader = openSummaryShardIndexDb({ dbPath: resolveMemoryIndexPaths().tier1DbPath });
    try { expect(reader.listIndexedSessionIds()).toContain(session.id); }
    finally { reader.close(); }
  });
});
