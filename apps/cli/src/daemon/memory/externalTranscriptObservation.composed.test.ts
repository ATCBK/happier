import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { normalizeMemorySettings } from '@happier-dev/protocol/memory/memorySettings';
import { createCodexExternalSessionsContribution } from '../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/contribution';
import { createExternalSessionObservationReconciler } from '@/api/session/external/leases/createExternalSessionObservationReconciler';
import { createBoundedAgentExternalSessionsContribution } from '@/session/external/agentExternalSessionsInvocation';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { openDeepIndexDb } from './deepIndex/deepIndexDb';
import { syncExternalMemoryTranscriptOnce } from './externalTranscriptIndex';

const filesystem = vi.hoisted(() => ({ opened: [] as string[] }));
// Only native I/O is observed; demand, bounded facade, codec and SQLite stay real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: (...args: Parameters<typeof actual.open>) => {
    filesystem.opened.push(String(args[0]));
    return actual.open(...args);
  } };
});

it('shares accounting observation facts with native indexing and releases them on disable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-observed-codex-'));
  const directory = join(root, 'sessions');
  await mkdir(directory);
  const files: string[] = [];
  const id = '11111111-1111-4111-8111-111111111111';
  for (let index = 0; index < 20; index++) {
    const file = join(directory, `rollout-fixture-${index}.jsonl`);
    files.push(file);
    await writeFile(file, JSON.stringify({ type: 'session_meta', payload: {
      id: index === 0 ? id : `unrelated-${index}`, cwd: '/fixture', base_instructions: { text: 'x'.repeat(24_000) },
    } }) + '\n' + JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'quartz observed native fact' }],
    } }) + '\n');
  }
  const db = openDeepIndexDb({ dbPath: join(root, 'deep.sqlite') });
  const observation = createExternalSessionObservationReconciler({ acquireObserver: async () => ({ dispose() {} }) });
  const demand = await observation.registerAccountingSource({
    resource: { pluginId: 'fixture.codex', agentLocalId: 'codex', occurrenceId: '1', resourceKey: 'accounting' },
    source: { kind: 'codexHome', home: 'user', homePath: root }, changeObservation: 'watch_file_changes',
    watchFileChanges: { files, topologyDirectories: [directory] }, onChange() {},
  });
  try {
    const reader = createBoundedAgentExternalSessionsContribution({ contribution: createCodexExternalSessionsContribution({ env: { CODEX_HOME: root } }),
      identity: { pluginId: 'fixture.codex', agentId: 'codex', occurrenceId: 'current',
        contributionQualifiedId: 'fixture.codex/agents/codex', sourceCustody: { kind: 'development', registeredRootId: 'fixture' } },
      retirementSignal: new AbortController().signal, isCurrent: () => true,
      createInvocationExec: async () => createUnavailablePluginServices().exec });
    const source = { type: 'external_transcript' as const, agentId: 'codex', sourceKey: 'local', nativeSessionId: id };
    const native = { agentId: 'codex', sourceKey: 'local', source: { kind: 'codexHome', home: 'user', homePath: root },
      reader, observation: demand.observation };
    const settings = normalizeMemorySettings({ enabled: true, indexMode: 'deep', backfillPolicy: 'all_history',
      coveragePolicy: { type: 'full' }, conversationSearch: { indexExternal: { enabled: true, agents: ['codex'] } } });
    const sync = () => syncExternalMemoryTranscriptOnce({ source, native, settings, db, nowMs: Date.now(), signal: new AbortController().signal });
    expect(await sync()).toBe('current');
    expect(db.getDeepIndexStats().deepChunkCount).toBe(1);
    filesystem.opened.length = 0;
    expect(await sync()).toBe('current');
    expect(filesystem.opened.filter(file => files.slice(1).includes(file))).toHaveLength(0);
    await demand.dispose();
    expect(demand.observation.lifetime.aborted).toBe(true);
    // A caller without live observation must establish fresh native facts.
    filesystem.opened.length = 0;
    expect(await syncExternalMemoryTranscriptOnce({ source, native: { ...native, observation: undefined },
      settings, db, nowMs: Date.now(), signal: new AbortController().signal })).toBe('current');
    expect(filesystem.opened.some(file => files.slice(1).includes(file))).toBe(true);
  } finally {
    await demand.dispose();
    await observation.dispose();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
