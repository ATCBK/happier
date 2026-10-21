import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';

import { normalizeMemorySettings } from '@happier-dev/protocol/memory/memorySettings';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import type { createMemoryExternalTranscriptSources } from './externalTranscriptSources';
import { openDeepIndexDb } from './deepIndex/deepIndexDb';
import type { Disposable } from '@happier-dev/plugin-sdk';
import { createInitialCodexExternalSessionIndexCursor, encodeCodexExternalSessionIndexCursor } from '../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/candidates';

const pluginId = 'acme.memory-inventory';
const agentId = `${pluginId}/fixture`;

// Keep cold graph transformation outside the per-scenario workload deadline.
await import('@/plugins/testkit/admittedRuntime');
await import('./externalTranscriptSources');

type ConfigureInventory = (next: (page: number) => string | null,
  options?: Readonly<{ available?: boolean; watchedFiles?: number; candidates?: boolean }>) => void;

async function withInventory(run: (sources: ReturnType<typeof createMemoryExternalTranscriptSources>, configure: ConfigureInventory,
  signal: AbortSignal, settings: ReturnType<typeof normalizeMemorySettings>, demands: WeakRef<Disposable>[], db: ReturnType<typeof openDeepIndexDb>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'happier-memory-inventory-'));
  const db = openDeepIndexDb({ dbPath: join(directory, 'index.sqlite') });
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  env.patch({ HAPPIER_HOME_DIR: directory, HAPPIER_SERVER_URL: 'https://home.test', HAPPIER_WEBAPP_URL: 'https://home.test' });
  vi.resetModules();
  const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
  const { createAuthoredAdmittedPluginRuntimeFixture: createRuntime } = await import('@/plugins/testkit/admittedRuntime');
  const { resolvePluginContributes } = await import('@/plugins/projection/registry/resolvePluginContributions');
  const { createResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
  const { createExternalSessionObservationDaemonProjection } = await import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection');
  let runtime: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
  let sources: ReturnType<typeof createMemoryExternalTranscriptSources> | undefined;
  const observation = createExternalSessionObservationDaemonProjection({
    publishField: async () => { throw new Error('Native inventory must not fabricate a Happier Session'); },
    // Replace only OS attachments; admission, resource sharing and disposal stay real.
    watchFile: () => () => {}, watchTopologyDirectory: () => () => {},
  });
  try {
    runtime = await createRuntime({ controller: pluginReloadController,
      resolveContributes: async happyHomeDir => createResolvedContributionRegistry(await resolvePluginContributes({ happyHomeDir })),
      plugins: [{
      manifest: createPluginManifestV2Fixture({ id: pluginId, runtime: { apiVersion: 1, agentFactories: [{ localAgentId: 'fixture',
        locator: { module: './factory', export: 'createFixtureAgentRuntime', runtimeApiVersion: 1, externalSessionsExport: 'externalSessions' },
        normalizedModulePath: 'factory.mjs', loadMode: 'immutable-js',
      }] }, contributes: { agents: [{
        id: 'fixture', title: 'Synthetic inventory', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { surfaces: ['externalSessions'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        surfaces: { externalSession: { sources: [{ sourceKind: 'inventoryFixture',
          schema: { fields: [{ kind: 'literal', name: 'kind', value: 'inventoryFixture' }] },
          key: { segments: [{ kind: 'literal', value: 'inventoryFixture' }] },
          instances: [{ kind: 'default', constants: {} }],
        }] } },
      }] } }),
      files: { 'factory.mjs': `
let next = () => null;
let available = true;
let watchedFiles = 0;
let candidates = false;
export function configure(value, options = {}) {
  next = value; available = options.available ?? true; watchedFiles = options.watchedFiles ?? 0; candidates = options.candidates ?? false;
}
export function createFixtureAgentRuntime() { return { sessions: {} }; }
export const externalSessions = {
    async resolveSource({ source }) { return available ? { ok: true, value: { source, ...(watchedFiles ? { accountingSource: {
      resourceKey: 'synthetic-accounting', changeObservation: 'watch_file_changes', watchFileChanges: {
        files: Array.from({ length: watchedFiles }, (_, index) => '/synthetic/inventory-' + index + '.jsonl'), topologyDirectories: [],
      },
    } } : {}) } } : { ok: false, code: 'unavailable', retryable: true }; },
    async listCandidates({ cursor }) {
      const page = cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString()).rolloutOffset : 0;
      return { ok: true, value: { candidates: candidates ? [{ remoteSessionId: 'fixture-' + page, updatedAtMs: Date.now() }] : [], nextCursor: next(page) } };
    },
    async resolveLinkIdentity({ source, remoteSessionId }) { return { ok: true, value: { source, remoteSessionId, linkData: {} } }; },
    async resolveLinkedIdentity({ source, remoteSessionId, linkData }) { return { ok: true, value: { source, remoteSessionId, linkData } }; },
    async pageTranscript() { return { ok: true, value: { items: [], nextCursor: null } }; },
    async readAfterTranscript() { return { ok: true, value: { outcome: 'already_current' } }; },
};`, 'daemon.mjs': `
import { createFixtureAgentRuntime, externalSessions } from './factory.mjs';
export { configure } from './factory.mjs';
export function activate(api) {
  api.agents.register('fixture', createFixtureAgentRuntime, { sessionRunnerFactory: {
    module: './factory', export: 'createFixtureAgentRuntime', runtimeApiVersion: 1, externalSessionsExport: 'externalSessions',
  } });
  api.agents.registerExternalSessions('fixture', externalSessions);
}` },
    }] });
    if (!runtime.registry.agentRuntimesByAgentId.get(agentId)?.externalSessions) {
      throw new Error(`Synthetic external reader was not admitted: ${JSON.stringify(runtime.registry.pluginDiagnosticsByPluginId[pluginId])}`);
    }
    const configureExport = runtime.modulesByPluginId.get(pluginId)?.configure;
    if (typeof configureExport !== 'function') throw new Error('Synthetic plugin configuration export unavailable');
    const configure: ConfigureInventory = (next, options) => { configureExport(next, options); };
    const { createMemoryExternalTranscriptSources: createSources } = await import('./externalTranscriptSources');
    sources = createSources({ credentials: { token: 'fixture', encryption: null }, onChange() {} });
    const demands: WeakRef<Disposable>[] = [];
    sources.attach({ registerAccountingSource: async input => {
      const demand = await observation.registerAccountingSource(input);
      demands.push(new WeakRef(demand));
      return demand;
    } });
    const signal = new AbortController().signal;
    const settings = normalizeMemorySettings({ v: 1, enabled: true, conversationSearch: { indexExternal: { enabled: true, agents: [agentId] } } });
    expect(settings.conversationSearch.indexExternal).toMatchObject({ enabled: true, agents: [agentId] });
    await sources.refresh(settings, signal);
    await run(sources, configure, signal, settings, demands, db);
  } finally {
    await sources?.dispose();
    await observation.dispose();
    await runtime?.dispose();
    await pluginReloadController.shutdown();
    db.close();
    env.restore();
    vi.resetModules();
    await rm(directory, { recursive: true, force: true });
  }
}

const cursor = (page: number) => encodeCodexExternalSessionIndexCursor({ ...createInitialCodexExternalSessionIndexCursor(), rolloutOffset: page });

describe('native inventory cursor lifetime', () => {
  it('reports a configured but unreadable native source as unavailable and recovers when it returns', async () => {
    await withInventory(async (sources, configure, signal, settings, _demands, db) => {
        configure(() => null, { available: false });
        await sources.refresh(settings, signal);
        await sources.inventory(signal);
        expect(sources.getIndexSources(db)).toMatchObject([{ state: 'error', errorCode: 'agent_unavailable' }]);
        configure(() => null);
        await sources.refresh(settings, signal);
        await sources.inventory(signal);
        expect(sources.getIndexSources(db)).toMatchObject([{ state: 'ready' }]);
        configure(() => null, { available: false });
        await sources.refresh(settings, signal);
        expect(sources.getIndexSources(db)).toMatchObject([{ state: 'error', errorCode: 'agent_unavailable' }]);
        expect(sources.getReadySourceCount()).toBe(0);
    });
  });

  it.each([1, 3])('rejects a repeated cursor across a %i-page cycle and recovers on a new crawl', async length => {
    await withInventory(async (sources, configure, signal, _settings, _demands, db) => {
      configure(page => cursor(page < length ? page + 1 : 1));
      for (let page = 0; page <= length; page++) {
        const result = await sources.inventory(signal);
        expect(result?.completeSources.size).toBe(0);
      }
      // The error remains observable, and a restarted crawl may reuse cursors.
        expect(sources.getIndexSources(db)).toMatchObject([{ state: 'error' }]);
        configure(page => page < length ? cursor(page + 1) : null);
        for (let page = 0; page <= length; page++) await sources.inventory(signal);
        expect(sources.getIndexSources(db)).toMatchObject([{ state: 'ready' }]);
        expect(await sources.inventory(signal)).toBeNull();
    });
  });

  it.skipIf(!process.env.HAPPIER_R240_INVENTORY_MEMORY)('releases retired observation demands while retaining inventory candidates', async () => {
    setFlagsFromString('--expose_gc');
    const collectGarbage = runInNewContext('gc') as () => void;
    await withInventory(async (sources, configure, signal, settings, demands) => {
      configure(page => page < 2 ? cursor(page + 1) : null, { watchedFiles: 300, candidates: true });
      for (let page = 0; page <= 2; page++) {
        await sources.refresh(settings, signal);
        await sources.inventory(signal);
      }
      await sources.refresh(settings, signal);
      await setImmediate(); collectGarbage();
      await setImmediate(); collectGarbage();
      const retiredRetained = demands.slice(0, -1).filter(demand => demand.deref() !== undefined).length;
      console.info('R240_INVENTORY_DEMANDS', JSON.stringify({ demands: demands.length, retiredRetained }));
      expect(sources.getReadySourceCount()).toBe(3);
      expect(demands).toHaveLength(4);
      expect(retiredRetained).toBe(0);
      expect(demands.at(-1)?.deref()).toBeDefined();
    });
  });

  it.skipIf(!process.env.HAPPIER_R240_INVENTORY_MEMORY)('retains one opaque preparation cursor while crawling and none after exhaustion', async () => {
    // Expose GC only inside this isolated synthetic workload; no live daemon
    // Inspector, heap snapshot, user home or transcript is accessed.
    setFlagsFromString('--expose_gc');
    const collectGarbage = runInNewContext('gc') as () => void;
    await withInventory(async (sources, configure, signal, settings) => {
      const preparation = { roots: 'synthetic', directories: [{ ref: { home: 0, path: 'sessions/2026/10/21' }, generation: 'synthetic',
        entries: Array.from({ length: 1500 }, (_, index) => ({ name: `rollout-2026-10-21T00-00-00-00000000-0000-4000-8000-${String(index).padStart(12, '0')}.jsonl`, kind: 'file' })) }], files: [], identities: [] };
      let emittedBytes = 0;
      let cursorBytes = 0;
      configure(page => {
        if (page === 128) return null;
        const next = encodeCodexExternalSessionIndexCursor({ ...createInitialCodexExternalSessionIndexCursor(), rolloutOffset: page + 1, preparation });
        cursorBytes = Buffer.byteLength(next);
        emittedBytes += cursorBytes;
        return next;
      });
      const sample = () => { collectGarbage(); return process.memoryUsage().heapUsed; };
      const baseline = sample();
      for (let page = 0; page < 64; page++) await sources.inventory(signal);
      const crawling = sample() - baseline;
      for (let page = 64; page <= 128; page++) await sources.inventory(signal);
      const exhausted = sample() - baseline;
      await sources.refresh({ ...settings, enabled: false }, signal);
      const disabled = sample() - baseline;
      console.info('R240_INVENTORY_MEMORY', JSON.stringify({ cursorBytes, emittedBytes, crawling, exhausted, disabled }));
      expect(emittedBytes).toBeGreaterThan(0);
      // A crawl cannot retain the history of native directory snapshots. The
      // allowance covers its latest cursor and transient host bookkeeping;
      // it scales with a page, never the number of previously consumed pages.
      expect(crawling).toBeLessThan(cursorBytes * 4);
      expect(exhausted).toBeLessThan(cursorBytes * 4);
      expect(sources.getReadySourceCount()).toBe(0);
    });
  });
});
