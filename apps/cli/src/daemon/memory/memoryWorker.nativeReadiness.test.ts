import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import axios from 'axios';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from '@/session/external/agentExternalSessionsInvocation';

const disk = vi.hoisted(() => ({ project: '', armOnWatch: '', armed: false, opens: 0, blockAt: 2,
  expiredPath: '', expiredOpens: 0,
  entered: () => {}, wait: Promise.resolve(), afterSettingsRead: null as (() => void) | null, settingsFile: '' }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (String(args[0]) === disk.expiredPath) disk.expiredOpens++;
    return actual.open(...args);
  }, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const result = await actual.readFile(...args);
    if (String(args[0]) === disk.settingsFile && disk.afterSettingsRead) {
      const release = disk.afterSettingsRead;
      disk.afterSettingsRead = null;
      // Let settings admission abort its tracked native operation before the
      // held OS directory read resumes. No internal reader is substituted.
      setImmediate(release);
    }
    return result;
  }, opendir: async (...args: Parameters<typeof actual.opendir>) => {
    if (disk.armed && String(args[0]) === disk.project && ++disk.opens === disk.blockAt) { disk.entered(); await disk.wait; }
    return actual.opendir(...args);
  } };
});

// This file has one scenario. Select its isolated Home before loading the real
// graph, so workload setup does not discard the warmed configuration/registry.
const directory = await mkdtemp(join(tmpdir(), 'happier-memory-native-worker-'));
const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'CLAUDE_CONFIG_DIR']);
env.patch({ HAPPIER_HOME_DIR: join(directory, 'home'), HAPPIER_SERVER_URL: 'https://home.test',
  HAPPIER_WEBAPP_URL: 'https://home.test', CLAUDE_CONFIG_DIR: join(directory, 'claude') });
(await import('@/configuration')).reloadConfiguration();
afterAll(async () => {
  env.restore();
  vi.resetModules();
  await rm(directory, { recursive: true, force: true });
});

// Transform the real registry and worker graph outside the workload deadline.
await import('@/api/api');
await import('@/plugins/testkit/admittedRuntime');
await import('./testkit/startMemoryWorker');
await import('./testkit/inProcessMemoryIndexer');
await import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection');

describe('memory worker native source readiness', () => {
  it('finishes an idle native source and discovers new in-window transcripts through the shared observer', async () => {
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'account', connectedServicesV2: [] } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === '/v2/sessions') return { status: 200, data: { sessions: [], nextCursor: null, hasNext: false } };
      throw new Error(`Unexpected native worker HTTP path: ${path}`);
    });
    let runtime: Awaited<ReturnType<typeof import('@/plugins/testkit/admittedRuntime').createAdmittedPluginRuntimeFixture>> | undefined;
    let worker: Awaited<ReturnType<typeof import('./memoryWorker').startMemoryWorker>> | undefined;
    let observation: ReturnType<typeof import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection').createExternalSessionObservationDaemonProjection> | undefined;
    let shutdownRegistry: (() => Promise<void>) | undefined;
    const fileChanges = new Map<string, (file: string) => void>();
    const topologyChanges = new Map<string, (file?: string) => void>();
    const notifyTopology = (changedPath: string) => {
      let watched = changedPath;
      while (!topologyChanges.has(watched)) {
        const parent = dirname(watched);
        if (parent === watched) throw new Error('Synthetic change has no covering topology observer');
        watched = parent;
      }
      // The real topology watcher is recursive: a demanded ancestor covers
      // additions/deletions without a second watcher on each descendant.
      topologyChanges.get(watched)!(changedPath);
    };
    let releaseDisk = () => {};
    let pendingSync: Promise<void> | undefined;
    const heap = process.env.HAPPIER_R224_PROFILE ? new Session() : null;
    const measurements: Array<{ phase: string; rss: number; heapUsed: number; details: unknown }> = [];
    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    const measure = async (phase: string) => {
      if (!heap) return;
      await heap.post('HeapProfiler.collectGarbage');
      const report: unknown = process.report.getReport();
      const heapReport = (value: unknown): unknown => {
        if (!value || typeof value !== 'object') return null;
        const record = value as Record<string, unknown>;
        return { heap: record.javascriptHeap, workers: Array.isArray(record.workers) ? record.workers.map(heapReport) : [] };
      };
      const { openSqliteDatabaseSync } = await import('../persistence/sqliteSync');
      const databases = [worker?.getTier1DbPhysicalPath?.(), worker?.getDeepDbPhysicalPath?.()].flatMap(path => {
        if (!path) return [];
        const db = openSqliteDatabaseSync(path, { readOnly: true });
        try { return [{ path, cache: db.prepare('PRAGMA cache_size').get(), mmap: db.prepare('PRAGMA mmap_size').get(),
          page: db.prepare('PRAGMA page_size').get(), pages: db.prepare('PRAGMA page_count').get() }]; }
        finally { db.close(); }
      });
      const item = { phase, ...process.memoryUsage(), details: { isolates: heapReport(report), databases,
        loopDelayMaxMs: loopDelay.max / 1e6, sources: worker?.getIndexSources?.().length, watchedFiles: fileChanges.size } };
      measurements.push(item);
      console.info('R237_MEMORY', JSON.stringify(item));
    };
    try {
      const project = join(directory, 'claude', 'projects', 'project');
      await mkdir(project, { recursive: true });
      const nowMs = Date.now();
      const row = (id: string, text: string, timestamp = nowMs) => JSON.stringify({ type: 'user', uuid: id,
        sessionId: id, timestamp: new Date(timestamp).toISOString(), message: { role: 'user', content: text } }) + '\n';
      const firstPath = join(project, 'first.jsonl');
      await writeFile(firstPath, row('first', 'quartz initial native message'));
      // The one-day policy must exclude old native bodies before title
      // enrichment, rather than decoding them and discarding the candidate.
      disk.expiredPath = join(project, 'expired.jsonl');
      disk.expiredOpens = 0;
      const expiredTime = new Date(nowMs - 30 * 86_400_000);
      await writeFile(disk.expiredPath, row('expired', 'expired native history', expiredTime.getTime())
        + (JSON.stringify({ type: 'progress', data: 'x'.repeat(16_000) }) + '\n').repeat(256));
      await utimes(disk.expiredPath, expiredTime, expiredTime);
      // More expired conversations than one native candidate page must not
      // delay the one eligible transcript behind whole-history pagination.
      const oldTimeBeyondWidenedWindow = new Date(nowMs - 30 * 86_400_000);
      for (let index = 0; index < 61; index++) {
        const path = join(project, `expired-${index}.jsonl`);
        await writeFile(path, row(`expired-${index}`, 'out-of-window history', oldTimeBeyondWidenedWindow.getTime()));
        await utimes(path, oldTimeBeyondWidenedWindow, oldTimeBeyondWidenedWindow);
      }
      const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
      shutdownRegistry = () => pluginReloadController.shutdown();
      const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
      const { createResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
      const { resolveBuiltInContributions } = await import('@/plugins/projection/registry/resolveBuiltInContributions');
      runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        runtimeOptions: { contributes: createResolvedContributionRegistry(resolveBuiltInContributions()), pluginIds: ['happier.agent.claude'] } });
      expect(runtime.registry.agentRuntimesByAgentId.get('claude')?.externalSessions).toBeTruthy();
      const { createExternalSessionObservationDaemonProjection } = await import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection');
      observation = createExternalSessionObservationDaemonProjection({
        publishField: async () => { throw new Error('Native indexing must not fabricate a Happier Session'); },
        // Only the OS watcher is replaced; resource admission and reconciliation stay real.
        watchFile: (file, onChange) => {
          fileChanges.set(file, onChange);
          // Source discovery finishes before the shared observer admits these
          // newly created files. Gate transcript inventory only after admission.
          if (file === disk.armOnWatch) disk.armed = true;
          return () => { fileChanges.delete(file); };
        },
        watchTopologyDirectory: (path, onChange) => { topologyChanges.set(path, onChange); return () => { topologyChanges.delete(path); }; },
      });
      const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
      await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep', backfillPolicy: 'all_history',
        coveragePolicy: { type: 'full' }, conversationSearch: { indexExternal: {
          enabled: true, agents: ['claude'], historyDays: 1, includeToolOutput: false,
        } } });
      const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
      worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine' });
      if (heap) {
        heap.connect();
        await heap.post('HeapProfiler.startSampling');
        await measure('before-observation');
        loopDelay.enable();
      }
      expect(worker.getSettings().conversationSearch.indexExternal).toMatchObject({ enabled: true, agents: ['claude'] });
      worker.attachExternalObservation!(observation);
      await worker.ensureUpToDate();
      const nativeSources = () => worker!.getIndexSources!().filter(row => row.source.type === 'external_transcript');
      expect(nativeSources()).toEqual([{ source: { type: 'external_transcript', agentId: 'claude', sourceKey: 'claudeConfig::' }, state: 'ready' }]);
      await worker.ensureUpToDate();
      expect(nativeSources()[0]?.state).toBe('ready');
      const { openDeepIndexDb } = await import('./deepIndex/deepIndexDb');
      const search = (query: string) => {
        const db = openDeepIndexDb({ dbPath: worker!.getDeepDbPath()! });
        try { return db.search({ query, scope: { type: 'global' }, maxResults: 10, includeExternal: true, includeSessions: false }); }
        finally { db.close(); }
      };
      expect(search('quartz')).toHaveLength(1);
      expect(disk.expiredOpens, 'expired transcript must not be opened for candidate titles').toBe(0);
      // An append to an admitted file must reach its incremental transcript
      // reader without waiting for a fresh whole-source file-set discovery.
      disk.project = project;
      disk.armed = true;
      disk.opens = 0;
      disk.blockAt = 1;
      const appendDiscoveryEntered = new Promise<void>(resolve => { disk.entered = resolve; });
      disk.wait = new Promise<void>(resolve => { releaseDisk = resolve; });
      await appendFile(firstPath, row('append', 'garnet appended native message'));
      fileChanges.get(firstPath)!(firstPath);
      pendingSync = worker.ensureUpToDate();
      expect(await Promise.race([pendingSync.then(() => 'tick finished'), appendDiscoveryEntered.then(() => 'waiting on whole-source discovery')]))
        .toBe('tick finished');
      releaseDisk();
      await pendingSync;
      disk.project = '';
      disk.armed = false;
      disk.blockAt = 2;
      expect(search('garnet')).toHaveLength(1);
      const addedPath = join(project, 'added.jsonl');
      await writeFile(addedPath, row('added', 'topaz newly discovered message'));
      const oldPath = join(project, 'old.jsonl');
      const oldTime = new Date(nowMs - 8 * 86_400_000);
      await writeFile(oldPath, row('old', 'obsolete outside history window', oldTime.getTime()));
      await utimes(oldPath, oldTime, oldTime);
      notifyTopology(addedPath);
      await worker.ensureUpToDate();
      await worker.ensureUpToDate();
      expect(search('topaz')).toHaveLength(1);
      expect(search('obsolete')).toEqual([]);
      const indexedNativeIds = () => {
        const db = openDeepIndexDb({ dbPath: worker!.getDeepDbPath()! });
        try { return db.listExternalSourceStates().map(state => state.source.nativeSessionId); }
        finally { db.close(); }
      };
      // An expired native conversation must not enter transcript traversal at
      // all: rejecting its rows only after reading it still scans old history.
      expect.soft(indexedNativeIds()).not.toContain('old');
      expect(nativeSources()[0]?.state).toBe('ready');

      // Widening the history window must rediscover sources excluded by the
      // completed inventory, without waiting for a native filesystem change.
      const oneDaySettings = worker.getSettings();
      await writeMemorySettingsToDisk({ ...oneDaySettings, conversationSearch: { ...oneDaySettings.conversationSearch,
        indexExternal: { ...oneDaySettings.conversationSearch.indexExternal, historyDays: 14 } } });
      await worker.reloadSettings();
      // Explicit refresh settles the newly admitted history regardless of its
      // native directory order or the scheduler's per-tick allowance.
      await worker.ensureUpToDate();
      expect.soft(search('obsolete')).toHaveLength(1);
      expect.soft(indexedNativeIds()).toContain('old');
      await writeMemorySettingsToDisk(oneDaySettings);
      await worker.reloadSettings();
      await worker.ensureUpToDate();
      expect(search('obsolete')).toEqual([]);
      expect.soft(indexedNativeIds()).not.toContain('old');

      // A real multi-page native inventory must let the worker ingest its first
      // page. Hold only the OS directory read for the next page, without a timer.
      const pageSize = EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxItems;
      const backlogSize = pageSize * 3;
      if (heap) {
        await measure('before-window');
      }
      const padding = (JSON.stringify({ type: 'progress', data: 'x'.repeat(16_000) }) + '\n').repeat(256);
      for (let index = 0; index < backlogSize; index++) {
        const path = join(project, `bulk-${index}.jsonl`);
        await writeFile(path, row(`bulk-${index}`, 'corundum inventory progress'));
        if (heap) await appendFile(path, padding);
      }
      disk.project = project;
      disk.armOnWatch = join(project, 'bulk-0.jsonl');
      disk.armed = false;
      disk.opens = 0;
      const secondPageEntered = new Promise<void>(resolve => { disk.entered = resolve; });
      disk.wait = new Promise<void>(resolve => { releaseDisk = resolve; });
      notifyTopology(join(project, 'bulk-0.jsonl'));
      pendingSync = worker.ensureUpToDate();
      expect(await Promise.race([pendingSync.then(() => 'tick finished'), secondPageEntered.then(() => 'waiting on next page')]))
        .toBe('waiting on next page');
      // A finite demand remains active for its admitted continuation, but its
      // first page is already queryable before the next OS read completes.
      expect(search('corundum').length).toBeGreaterThan(0);
      expect(nativeSources()[0]?.state).toBe('indexing');
      // An already-indexed conversation stays fresh while initial work on
      // other conversations is queued. This must use the same worker budget.
      await appendFile(firstPath, row('concurrent-append', 'zircon concurrent backlog append'));
      fileChanges.get(firstPath)!(firstPath);
      const { MemoryWorkerStatusV1Schema } = await import('@happier-dev/protocol/memory/memoryStatus');
      expect(MemoryWorkerStatusV1Schema.parse(worker.getWorkerStatus()).activeOperations).toEqual([
        { kind: 'transcript', sessionIds: [] },
      ]);
      releaseDisk();
      await pendingSync;
      disk.project = '';
      disk.armOnWatch = '';
      disk.armed = false;
      expect(search('zircon'), 'the active run must consume an append received during inventory').toHaveLength(1);
      expect(search('corundum').length).toBeGreaterThan(0);
      expect(nativeSources()[0]?.state).toBe('ready');
      if (heap) {
        await measure('ready');
        const artifact = await mkdtemp('/var/tmp/happier-r224-');
        const { profile } = await heap.post('HeapProfiler.getSamplingProfile');
        await writeFile(join(artifact, 'heap-sampling.json'), JSON.stringify(profile));
        const result = { artifact, windowBytes: backlogSize * padding.length, measurements };
        await writeFile(join(artifact, 'measurements.json'), JSON.stringify(result));
        console.log('R224_PROFILE', JSON.stringify(result));
        // Reject retention proportional to the whole corpus, while allowing
        // the registry, bounded pages, SQLite and allocator high-water marks.
        expect(measurements.at(-1)!.rss - measurements[0]!.rss).toBeLessThan(backlogSize * padding.length / 4);
      }

      await rm(addedPath);
      // A known file's rename/delete is owned by its file observer; topology
      // deliberately ignores it rather than scheduling duplicate observation.
      fileChanges.get(addedPath)!(addedPath);
      notifyTopology(addedPath);
      // The demand includes retained transcript work and any fresh inventory
      // absence proof requested by a removed transcript's result.
      await worker.ensureUpToDate();
      expect(search('topaz')).toEqual([]);
      expect(nativeSources()[0]?.state).toBe('ready');
      await rm(project, { recursive: true });
      notifyTopology(project);
      await worker.ensureUpToDate();
      expect(search('corundum')).toEqual([]);
      expect(nativeSources()[0]?.state).toBe('ready');

      // Turning native indexing off aborts an in-flight source refresh, drains
      // it and releases every observation demand before acknowledging settings.
      await mkdir(project, { recursive: true });
      await writeFile(firstPath, row('replacement', 'sapphire pending native refresh'));
      disk.project = project;
      disk.armed = true;
      disk.opens = 0;
      disk.blockAt = 1;
      const refreshEntered = new Promise<void>(resolve => { disk.entered = resolve; });
      disk.wait = new Promise<void>(resolve => { releaseDisk = resolve; });
      notifyTopology(project);
      pendingSync = worker.ensureUpToDate();
      const pendingOutcome = pendingSync.then(() => 'completed', error => error instanceof Error ? error.name : 'unknown');
      await refreshEntered;
      const enabledSettings = worker.getSettings();
      await writeMemorySettingsToDisk({ ...enabledSettings, conversationSearch: { ...enabledSettings.conversationSearch,
        indexExternal: { ...enabledSettings.conversationSearch.indexExternal, enabled: false } } });
      disk.settingsFile = join(directory, 'home', 'settings.json');
      disk.afterSettingsRead = releaseDisk;
      await worker.reloadSettings();
      expect(await pendingOutcome).toBe('AbortError');
      expect(nativeSources()).toEqual([]);
      expect(fileChanges.size).toBe(0);
      await measure('native-disabled');
      disk.project = '';
      disk.armed = false;
      await writeMemorySettingsToDisk(enabledSettings);
      await worker.reloadSettings();
      await worker.ensureUpToDate();
      expect(search('sapphire')).toHaveLength(1);
      await worker.stop();
      // The daemon may retain serializable coverage facts after Stop. Resource
      // release is established by observation disposal and closed DB paths.
      expect(fileChanges.size).toBe(0);
      expect(topologyChanges.size).toBe(0);
      expect(worker.getTier1DbPath()).toBeNull();
      expect(worker.getDeepDbPath()).toBeNull();
    } catch (error) {
      console.error('Native readiness workload failed before cleanup', error);
      throw error;
    } finally {
      loopDelay.disable();
      heap?.disconnect();
      releaseDisk();
      await pendingSync?.catch(() => {});
      disk.project = '';
      disk.armOnWatch = '';
      disk.armed = false;
      disk.blockAt = 2;
      disk.afterSettingsRead = null;
      disk.settingsFile = '';
      await worker?.stop();
      await observation?.dispose();
      await runtime?.dispose();
      await shutdownRegistry?.();
      get.mockRestore();
    }
  }, process.env.HAPPIER_R224_PROFILE ? 0 : undefined);
});
