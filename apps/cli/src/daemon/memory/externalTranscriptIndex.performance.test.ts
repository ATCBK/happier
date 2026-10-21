import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Session } from 'node:inspector/promises';
import { expect, it } from 'vitest';
import { normalizeMemorySettings } from '@happier-dev/protocol/memory/memorySettings';
import { createClaudeExternalSessionsContribution } from '../../../../../packages/plugins/claude/src/agent/surfaces/sessions/external/contribution';
import { createCodexExternalSessionsContribution } from '../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/contribution';
import { createBoundedAgentExternalSessionsContribution } from '@/session/external/agentExternalSessionsInvocation';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { openDeepIndexDb } from './deepIndex/deepIndexDb';
import { syncExternalMemoryTranscriptOnce } from './externalTranscriptIndex';
import { createMemorySessionLocalityReader, isMemorySessionOnMachine } from './inventory/refreshMemoryInventory';
import { encodeBase64, encryptLegacy } from '@/api/encryption';
import type { RawSessionListRow } from '@/session/transport/http/sessionsHttp';
import type { StoredCredentials } from '@/persistence';

it.skipIf(!process.env.HAPPIER_R230_PROFILE)('measures unchanged owner locality through the original and reused reader', () => {
  const secret = new Uint8Array(32).fill(19);
  const credentials: StoredCredentials = { token: 'fixture', encryption: { type: 'legacy', secret } };
  const sessions = Array.from({ length: 64 }, (_, index) => ({ id: `fixture-${index}`, seq: 1,
    createdAt: 1000, updatedAt: 1000, active: false, activeAt: 0, archivedAt: null, share: null,
    encryptionMode: 'e2ee', metadata: encodeBase64(encryptLegacy({ machineId: index % 2 ? 'foreign' : 'local',
      path: '/synthetic', description: 'synthetic '.repeat(1024) }, secret)),
  } as RawSessionListRow));
  const reader = createMemorySessionLocalityReader({ credentials, machineId: 'local' });
  for (const session of sessions) reader.isOnMachine(session, 'e2ee');
  for (const [phase, read] of [
    ['original', (session: RawSessionListRow) => isMemorySessionOnMachine({ credentials, machineId: 'local', session, accountEncryptionMode: 'e2ee' })],
    ['reused', (session: RawSessionListRow) => reader.isOnMachine(session, 'e2ee')],
  ] as const) {
    const baseline = process.memoryUsage();
    const cpu = process.cpuUsage();
    const started = performance.now();
    let local = 0;
    for (let tick = 0; tick < 10; tick++) for (const session of sessions) if (read(session)) local++;
    console.info(JSON.stringify({ benchmark: 'r230-owner-locality', phase, rows: sessions.length, ticks: 10,
      elapsedMs: performance.now() - started, cpu: process.cpuUsage(cpu), baseline, final: process.memoryUsage() }));
    expect(local).toBe(320);
  }
});

// Explicit synthetic workload; never discovers a user's native home. Run the
// same command before and after a performance change, outside routine suites.
it.skipIf(!process.env.HAPPIER_R230_PROFILE).each(['claude', 'codex'] as const)(
  'measures %s native page ingestion and event-loop delay', async agentId => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-memory-r230-'));
    const db = openDeepIndexDb({ dbPath: join(directory, 'index.sqlite') });
    const delay = monitorEventLoopDelay({ resolution: 10 });
    const profiler = new Session();
    try {
      const project = agentId === 'claude' ? join(directory, 'projects', 'project') : join(directory, 'sessions', '2026', '10', '21');
      await mkdir(project, { recursive: true });
      const sessionId = '11111111-1111-4111-8111-111111111111';
      const path = join(project, agentId === 'claude' ? `${sessionId}.jsonl` : `rollout-2026-10-21T00-00-00-${sessionId}.jsonl`);
      const timestamp = new Date().toISOString();
      const file = await open(path, 'w');
      let sizeBytes = 0;
      try {
        if (agentId === 'codex') {
          const header = JSON.stringify({ type: 'session_meta', timestamp, payload: { id: sessionId, cwd: '/synthetic' } }) + '\n';
          await file.writeFile(header); sizeBytes += Buffer.byteLength(header);
        }
        // Realistic JSONL: mixed visible messages and tool-sized bodies, not a
        // sparse file. Generated content is identical on both runs.
        for (let index = 0; index < 4096; index++) {
          const text = `quartz native fact ${index} ${'abc '.repeat(4096)}`;
          const line = JSON.stringify(agentId === 'claude'
            ? { type: 'user', uuid: String(index), sessionId, timestamp, message: { role: 'user', content: text } }
            : { type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n';
          await file.writeFile(line); sizeBytes += Buffer.byteLength(line);
        }
      } finally { await file.close(); }
      const contribution = agentId === 'claude' ? createClaudeExternalSessionsContribution({ env: {} })
        : createCodexExternalSessionsContribution({ env: { CODEX_HOME: directory } });
      const reader = createBoundedAgentExternalSessionsContribution({ contribution,
        identity: { pluginId: `fixture.${agentId}`, agentId, occurrenceId: 'current',
          contributionQualifiedId: `fixture.${agentId}/agents/${agentId}`, sourceCustody: { kind: 'development', registeredRootId: 'fixture' } },
        retirementSignal: new AbortController().signal, isCurrent: () => true,
        createInvocationExec: async () => createUnavailablePluginServices().exec });
      const source = { type: 'external_transcript' as const, agentId, sourceKey: 'synthetic', nativeSessionId: sessionId };
      const native = { agentId, sourceKey: 'synthetic', reader, source: agentId === 'claude'
        ? { kind: 'claudeConfig', configDir: directory } : { kind: 'codexHome', home: 'user' } };
      const settings = normalizeMemorySettings({ enabled: true, indexMode: 'deep', backfillPolicy: 'all_history',
        coveragePolicy: { type: 'full' }, conversationSearch: { indexExternal: { enabled: true, agents: [agentId] } } });
      db.init();
      // Exclude cold module transformation from sustained ingestion cost.
      await syncExternalMemoryTranscriptOnce({ source, native, db, settings, nowMs: Date.now(), signal: new AbortController().signal });
      profiler.connect();
      await profiler.post('Profiler.enable');
      await profiler.post('Profiler.start');
      const baseline = process.memoryUsage();
      const cpu = process.cpuUsage();
      delay.enable();
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      const started = performance.now();
      const outcomes: string[] = [];
      for (let page = 0; page < 8; page++) outcomes.push(await syncExternalMemoryTranscriptOnce({ source, native, db,
        settings, nowMs: Date.now(), signal: new AbortController().signal }));
      const elapsedMs = performance.now() - started;
      const { profile } = await profiler.post('Profiler.stop');
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      console.info(JSON.stringify({ benchmark: 'r230-native-pages', agentId, sizeBytes, pages: outcomes.length,
        outcomes, elapsedMs, cpu: process.cpuUsage(cpu), baseline, final: process.memoryUsage(),
        loopDelayMaxMs: delay.max / 1e6, loopDelayP99Ms: delay.percentile(99) / 1e6,
        sampledHotspots: [...profile.nodes].sort((a, b) => (b.hitCount ?? 0) - (a.hitCount ?? 0)).slice(0, 10)
          .map(node => ({ name: node.callFrame.functionName, url: node.callFrame.url, hits: node.hitCount })),
        chunks: db.getDeepIndexStats().deepChunkCount }));
      expect(outcomes.every(outcome => outcome === 'more')).toBe(true);
      expect(db.search({ query: 'quartz', scope: { type: 'global' }, maxResults: 1, includeExternal: true })).toHaveLength(1);
    } finally { profiler.disconnect(); delay.disable(); db.close(); await rm(directory, { recursive: true, force: true }); }
  }, 120_000,
);
