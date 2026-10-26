import { mkdir, mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Session } from 'node:inspector/promises';
import { performance } from 'node:perf_hooks';
import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';

async function readInotifyWatchCount() {
  if (process.platform !== 'linux') return null;
  const names = await readdir('/proc/self/fdinfo');
  const contents = await Promise.all(names.map(name => readFile(`/proc/self/fdinfo/${name}`, 'utf8').catch(() => '')));
  return contents.reduce((total, content) => total + (content.match(/^inotify wd:/gm)?.length ?? 0), 0);
}

// Diagnostic workload only. All source/index/settings bytes belong to this
// fixture's scratch home; HTTP is the only substituted system boundary.
if (process.env.HAPPIER_R175_PROFILE) {
  await import('@/api/api');
  await import('@/plugins/testkit/admittedRuntime');
  await import('./testkit/startMemoryWorker');
  await import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection');
}

it.skipIf(!process.env.HAPPIER_R175_PROFILE)('profiles the real native enable path', async () => {
  // hstack owns and removes its per-command TMPDIR on exit. Keep diagnostic
  // artifacts in an explicitly lane-owned disk-backed scratch directory.
  const directory = await mkdtemp('/var/tmp/happier-diag-r175-');
  const count = Number(process.env.HAPPIER_R175_FILES ?? 20_000);
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HAPPIER_CODEX_HOME']);
  env.patch({ HAPPIER_HOME_DIR: join(directory, 'home'), HAPPIER_SERVER_URL: 'https://home.test',
    HAPPIER_WEBAPP_URL: 'https://home.test', CLAUDE_CONFIG_DIR: join(directory, 'claude'),
    CODEX_HOME: join(directory, 'codex'), HAPPIER_CODEX_HOME: join(directory, 'codex') });
  vi.resetModules();
  const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'account', connectedServicesV2: [] } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    if (path === '/v2/sessions') return { status: 200, data: { sessions: [], nextCursor: null, hasNext: false } };
    throw new Error(`Unexpected diagnostic HTTP path: ${path}`);
  });
  let runtime: Awaited<ReturnType<typeof import('@/plugins/testkit/admittedRuntime').createAdmittedPluginRuntimeFixture>> | undefined;
  let worker: Awaited<ReturnType<typeof import('./memoryWorker').startMemoryWorker>> | undefined;
  let observation: ReturnType<typeof import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection').createExternalSessionObservationDaemonProjection> | undefined;
  const inspector = new Session();
  try {
    const now = new Date().toISOString();
    const claudeDirs = Array.from({ length: 90 }, (_, i) => join(directory, 'claude', 'projects', `project-${i}`));
    const codexDirs = Array.from({ length: 75 }, (_, i) => {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10).split('-');
      return join(directory, 'codex', i % 2 ? 'archived_sessions' : 'sessions', ...date);
    });
    await Promise.all([...claudeDirs, ...codexDirs].map(path => mkdir(path, { recursive: true })));
    const files: string[] = [];
    for (let i = 0; i < 700; i++) {
      const id = `claude-${i}`;
      const path = join(claudeDirs[i % claudeDirs.length]!, `${id}.jsonl`);
      await writeFile(path, JSON.stringify({ type: 'user', uuid: id, sessionId: id, timestamp: now,
        message: { role: 'user', content: 'quartz native profile' } }) + '\n');
      if (i < 2) files.push(path);
    }
    for (let i = 0; i < count; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const path = join(codexDirs[i % codexDirs.length]!, `rollout-${now.slice(0, 10)}T00-00-00-${id}.jsonl`);
      await writeFile(path, JSON.stringify({ type: 'session_meta', timestamp: now,
        payload: { id, timestamp: now, cwd: '/tmp/r175', originator: 'codex_cli_rs', cli_version: '0.145.0', source: 'cli' } }) + '\n'
        + JSON.stringify({ type: 'response_item', timestamp: now, payload: { type: 'message', role: 'user',
          content: [{ type: 'input_text', text: 'garnet native profile' }] } }) + '\n');
      if (i < 2) files.push(path);
    }
    // Several real, large JSONL files: 4 x 64 MiB, never a sparse file or
    // unbounded single JSON value. Setup is outside the CPU measurement.
    for (const path of files) {
      const handle = await open(path, 'a');
      const line = JSON.stringify({ type: 'r175_padding', value: 'x'.repeat(16_000) }) + '\n';
      const block = line.repeat(64);
      try { for (let i = 0; i < 64; i++) await handle.write(block); }
      finally { await handle.close(); }
    }
    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
    const { createResolvedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
    const { resolveBuiltInContributions } = await import('@/plugins/projection/registry/resolveBuiltInContributions');
    runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { contributes: createResolvedContributionRegistry(resolveBuiltInContributions()), pluginIds: ['happier.agent.claude', 'happier.agent.codex'] } });
    const { createExternalSessionObservationDaemonProjection } = await import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection');
    observation = createExternalSessionObservationDaemonProjection({
      publishField: async () => { throw new Error('Synthetic native sources cannot publish Happier sessions'); },
    });
    const { writeMemorySettingsToDisk } = await import('@/settings/memorySettings');
    await writeMemorySettingsToDisk({ v: 1, enabled: true, indexMode: 'deep', backfillPolicy: 'all_history', coveragePolicy: { type: 'full' } });
    const { startMemoryWorker } = await import('./testkit/startMemoryWorker');
    worker = await startMemoryWorker({ credentials: { token: 'fixture', encryption: null }, machineId: 'machine' });
    worker.attachExternalObservation!(observation);
    const measurements: Record<string, unknown>[] = [];
    measurements.push({ phase: 'baseline', ...process.memoryUsage(), inotifyWatches: await readInotifyWatchCount() });
    inspector.connect();
    await inspector.post('Profiler.enable');
    if (process.env.HAPPIER_R193_ALLOCATIONS) await inspector.post('HeapProfiler.startSampling');
    for (const [phase, operation] of [
      ['enable', async () => {
        await writeMemorySettingsToDisk({ ...worker!.getSettings(), conversationSearch: { ...worker!.getSettings().conversationSearch,
          indexExternal: { enabled: true, agents: ['claude', 'codex'], historyDays: 7, includeToolOutput: false } } });
        await worker!.reloadSettings();
      }],
      ['inventory-ingestion', () => worker!.ensureUpToDate()],
    ] as const) {
      await inspector.post('Profiler.start');
      let last = performance.now();
      let maxDelayMs = 0;
      let peakRss = process.memoryUsage().rss;
      let peakHeapUsed = process.memoryUsage().heapUsed;
      const timer = setInterval(() => {
        const current = performance.now();
        maxDelayMs = Math.max(maxDelayMs, current - last - 10);
        last = current;
        const memory = process.memoryUsage();
        peakRss = Math.max(peakRss, memory.rss);
        peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
      }, 10);
      const started = performance.now();
      await operation();
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      clearInterval(timer);
      const elapsedMs = performance.now() - started;
      const { profile } = await inspector.post('Profiler.stop');
      await writeFile(join(directory, `${phase}.cpuprofile`), JSON.stringify(profile));
      if (process.env.HAPPIER_R193_ALLOCATIONS) {
        const { profile: allocations } = await inspector.post('HeapProfiler.getSamplingProfile');
        await writeFile(join(directory, `${phase}.heap-sampling.json`), JSON.stringify(allocations));
      }
      measurements.push({ phase, elapsedMs, maxDelayMs, ...process.memoryUsage(), peakRss, peakHeapUsed,
        inotifyWatches: await readInotifyWatchCount() });
    }
    expect(worker.getSettings().conversationSearch.indexExternal.enabled).toBe(true);
    const sources = worker.getIndexSources!();
    expect(sources.some(row => row.source.type === 'external_transcript' && row.source.agentId === 'claude')).toBe(true);
    expect(sources.some(row => row.source.type === 'external_transcript' && row.source.agentId === 'codex')).toBe(true);
    const result = { directory, codexFiles: count, claudeFiles: 700, largeFileCount: files.length, measurements, sources };
    await writeFile(join(directory, 'measurements.json'), JSON.stringify(result, null, 2));
    console.log('R175_PROFILE', JSON.stringify(result));
  } finally {
    inspector.disconnect();
    await worker?.stop();
    await observation?.dispose();
    await runtime?.dispose();
    get.mockRestore();
    env.restore();
    vi.resetModules();
    // Preserve only lane-owned synthetic data and profiles for before/after.
  }
}, 0);
