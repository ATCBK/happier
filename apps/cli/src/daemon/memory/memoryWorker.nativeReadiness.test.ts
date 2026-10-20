import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from '@/session/external/agentExternalSessionsInvocation';

const disk = vi.hoisted(() => ({ project: '', armOnWatch: '', armed: false, opens: 0, blockAt: 2,
  entered: () => {}, wait: Promise.resolve(), afterSettingsRead: null as (() => void) | null, settingsFile: '' }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
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

// Transform the real registry and worker graph outside the workload deadline.
await import('@/api/api');
await import('@/plugins/testkit/admittedRuntime');
await import('./memoryWorker');
await import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection');

describe('memory worker native source readiness', () => {
  it('finishes an idle native source and discovers new in-window transcripts through the shared observer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-memory-native-worker-'));
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'CLAUDE_CONFIG_DIR']);
    env.patch({ HAPPIER_HOME_DIR: join(directory, 'home'), HAPPIER_SERVER_URL: 'https://home.test',
      HAPPIER_WEBAPP_URL: 'https://home.test', CLAUDE_CONFIG_DIR: join(directory, 'claude') });
    vi.resetModules();
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
    try {
      const project = join(directory, 'claude', 'projects', 'project');
      await mkdir(project, { recursive: true });
      const nowMs = Date.now();
      const row = (id: string, text: string, timestamp = nowMs) => JSON.stringify({ type: 'user', uuid: id,
        sessionId: id, timestamp: new Date(timestamp).toISOString(), message: { role: 'user', content: text } }) + '\n';
      const firstPath = join(project, 'first.jsonl');
      await writeFile(firstPath, row('first', 'quartz initial native message'));
      const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
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
          enabled: true, agents: ['claude'], historyDays: 7, includeToolOutput: false,
        } } });
      const { startMemoryWorker } = await import('./memoryWorker');
      worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine' });
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
      const sevenDaySettings = worker.getSettings();
      await writeMemorySettingsToDisk({ ...sevenDaySettings, conversationSearch: { ...sevenDaySettings.conversationSearch,
        indexExternal: { ...sevenDaySettings.conversationSearch.indexExternal, historyDays: 14 } } });
      await worker.reloadSettings();
      await worker.ensureUpToDate();
      expect.soft(search('obsolete')).toHaveLength(1);
      expect.soft(indexedNativeIds()).toContain('old');
      await writeMemorySettingsToDisk(sevenDaySettings);
      await worker.reloadSettings();
      await worker.ensureUpToDate();
      expect(search('obsolete')).toEqual([]);
      expect.soft(indexedNativeIds()).not.toContain('old');

      // A real multi-page native inventory must let the worker ingest its first
      // page. Hold only the OS directory read for the next page, without a timer.
      const pageSize = EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates.maxItems;
      for (let index = 0; index < pageSize; index++) {
        await writeFile(join(project, `bulk-${index}.jsonl`), row(`bulk-${index}`, 'corundum inventory progress'));
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
        .toBe('tick finished');
      expect(nativeSources()[0]?.state).toBe('indexing');
      pendingSync = worker.ensureUpToDate();
      await secondPageEntered;
      releaseDisk();
      await pendingSync;
      disk.project = '';
      disk.armOnWatch = '';
      disk.armed = false;
      // Drain the real worker's existing per-tick transcript allowance.
      for (let index = 0; index < Math.ceil((pageSize + 3) / worker.getSettings().worker.maxSessionsPerTick); index++) {
        await worker.ensureUpToDate();
      }
      expect(search('corundum').length).toBeGreaterThan(0);
      expect(nativeSources()[0]?.state).toBe('ready');

      await rm(addedPath);
      // A known file's rename/delete is owned by its file observer; topology
      // deliberately ignores it rather than scheduling duplicate observation.
      fileChanges.get(addedPath)!(addedPath);
      notifyTopology(addedPath);
      // Drain the existing source allowance after invalidating source freshness.
      for (let index = 0; index < Math.ceil((pageSize + 3) / worker.getSettings().worker.maxSessionsPerTick); index++) {
        await worker.ensureUpToDate();
      }
      // The deleted transcript can occupy the final traversal slot. Its
      // source_unavailable result requests fresh inventory absence proof;
      // drain that inventory's existing candidate-page allowance as well.
      for (let index = 0; index < Math.ceil((pageSize + 3) / pageSize); index++) {
        await worker.ensureUpToDate();
      }
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
      disk.project = '';
      disk.armed = false;
      await writeMemorySettingsToDisk(enabledSettings);
      await worker.reloadSettings();
      await worker.ensureUpToDate();
      expect(search('sapphire')).toHaveLength(1);
      await worker.stop();
      // A retained handle must not keep native reader/inventory references
      // alive after the worker's lifetime ends.
      expect(nativeSources()).toEqual([]);
    } finally {
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
      get.mockRestore();
      env.restore();
      vi.resetModules();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
