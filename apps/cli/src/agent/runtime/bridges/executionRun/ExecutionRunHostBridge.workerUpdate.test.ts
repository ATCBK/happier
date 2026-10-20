import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionRunState } from './executionRunTypes';
import { configuration, reloadConfiguration } from '@/configuration';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { finishExecutionRun } from './finishExecutionRun';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

const filesystemBoundary = vi.hoisted(() => ({
  onOpen: null as null | ((path: unknown, handle: import('node:fs/promises').FileHandle) => void),
}));

// Preserve real file handles and all registry logic while controlling one competing OS read.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      filesystemBoundary.onOpen?.(args[0], handle);
      return handle;
    },
  };
});

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'happier-worker-update-'));
  vi.stubEnv('HAPPIER_HOME_DIR', directory);
  vi.stubEnv('HAPPIER_PUBLIC_RELEASE_CHANNEL', undefined);
  vi.stubEnv('HAPPIER_RELEASE_RING', undefined);
  vi.stubEnv('HAPPIER_RELEASE_CHANNEL', undefined);
  filesystemBoundary.onOpen = null;
  reloadConfiguration();
});
afterEach(() => {
  vi.unstubAllEnvs();
  filesystemBoundary.onOpen = null;
  reloadConfiguration();
  rmSync(directory, { recursive: true, force: true });
});

async function createBridge() {
  return new ExecutionRunHostBridge({
    parentProvider: 'acme.parent', cwd: directory, happyHomeDir: directory,
    sendAcp: async () => {},
  });
}

async function readNaturalWorkerUpdate(bridge: ExecutionRunHostBridge, signal: AbortSignal) {
  return (await bridge.prepareWorkerUpdates('parent_session', { signal }))[0] ?? null;
}

/** Real terminal owner state and disk custody; no internal runtime factory is mocked. */
async function retainTerminalRun(finalText: unknown = 'The requested change is implemented.', ciphertextOverride?: string,
  status: 'succeeded' | 'failed' = 'succeeded', runReportPolicy?: FollowPolicyV1) {
  const run: ExecutionRunState = {
    runId: 'retained-run', callId: 'call-1', sidechainId: 'side-1', sessionId: 'parent_session', depth: 0,
    intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'acme.actual' }, backendId: 'acme.actual',
    effectiveEngine: { agentId: 'acme.actual', modelId: 'actual-model' },
    instructions: 'Implement the change.', permissionMode: 'read_only', retentionPolicy: 'resumable',
    runClass: 'bounded', ioMode: 'request_response', notifyParentOnCompletion: true,
    ...(runReportPolicy ? { runReportPolicy } : {}),
    status: 'running', startedAtMs: 1,
  };
  const runs = new Map([[run.runId, run]]);
  await finishExecutionRun({
    runId: run.runId, next: { status, finishedAtMs: 2 }, toolResult: { output: finalText },
    runs, controllers: new Map(), budgetRegistry: null, parentProvider: 'acme.parent', sendAcp: async () => {},
    enqueueMarkerWrite: async (_runId, write) => { await write(); }, terminalMarkerWritePromises: new Map(),
  });
  if (ciphertextOverride) {
    const markerDir = join(directory, 'tmp', 'daemon-execution-runs');
    const entry = readdirSync(markerDir).find((name) => name.startsWith('worker-update-') && name.endsWith('.sealed'));
    if (!entry) throw new Error('Expected the retained terminal custody file');
    writeFileSync(join(markerDir, entry), ciphertextOverride);
  }
  return runs.get(run.runId)!;
}

describe('execution-run retained WorkerUpdate inbox custody', () => {
  it('retains a separate exact terminal occurrence after parent report suppression and ACK', async () => {
    const { readRetainedExecutionRunRecord } = await import('@/daemon/executionRunRegistry');
    await retainTerminalRun('Unselected for parent', undefined, 'succeeded', { preset: 'custom', events: {} });
    const unselected = await readRetainedExecutionRunRecord('retained-run');
    expect(unselected?.terminalOccurrenceId).toEqual(expect.any(String));
    expect(unselected).not.toHaveProperty('terminalEventId');
    await retainTerminalRun('Selected for parent', undefined, 'failed', { preset: 'everything' });
    const selected = await readRetainedExecutionRunRecord('retained-run');
    expect(selected?.terminalOccurrenceId).toEqual(expect.any(String));
    expect(selected?.terminalOccurrenceId).not.toBe(unselected?.terminalOccurrenceId);
    const bridge = await createBridge();
    const update = await bridge.takeWorkerUpdate('parent_session', new AbortController().signal);
    expect(update).not.toBeNull();
    update!.acknowledgeAccepted();
    await bridge.prepareWorkerUpdates('parent_session', { signal: new AbortController().signal });
    const accepted = await readRetainedExecutionRunRecord('retained-run');
    expect(accepted?.terminalOccurrenceId).toBe(selected?.terminalOccurrenceId);
    expect(accepted).not.toHaveProperty('terminalEventId');
  });
  it('retains each run creation policy across restart and uses it for report selection and wake', async () => {
    await retainTerminalRun('Quiet failure', undefined, 'failed', { preset: 'quiet' });
    let bridge = await createBridge();
    const signal = new AbortController().signal;
    expect(await bridge.takeWorkerUpdate('parent_session', signal)).toBeNull();
    const [quiet] = await bridge.prepareWorkerUpdates('parent_session', { signal });
    expect(quiet?.update.result).toBe('Quiet failure');
    quiet!.acknowledgeAccepted();
    await bridge.prepareWorkerUpdates('parent_session', { signal });
    await retainTerminalRun('Interrupting success', undefined, 'succeeded', { preset: 'everything' });
    bridge = await createBridge();
    const awake = await bridge.takeWorkerUpdate('parent_session', signal);
    expect(awake?.update.result).toBe('Interrupting success');
    awake!.acknowledgeAccepted();
    await bridge.prepareWorkerUpdates('parent_session', { signal });
    await retainTerminalRun('Unselected success', undefined, 'succeeded', { preset: 'custom', events: {} });
    bridge = await createBridge();
    expect(await bridge.takeWorkerUpdate('parent_session', signal)).toBeNull();
    expect(await bridge.prepareWorkerUpdates('parent_session', { signal })).toEqual([]);
    const { readRetainedExecutionRunRecord } = await import('@/daemon/executionRunRegistry');
    expect(await readRetainedExecutionRunRecord('retained-run')).not.toHaveProperty('terminalEventId');
  });
  it('keeps successful reports for a natural turn and wakes only for an important failed outcome', async () => {
    await retainTerminalRun('Successful report');
    const bridge = await createBridge();
    const signal = new AbortController().signal;
    expect(await bridge.takeWorkerUpdate('parent_session', signal)).toBeNull();
    const quiet = await bridge.prepareWorkerUpdates('parent_session', { signal });
    expect(quiet.map(item => item.update.result)).toEqual(['Successful report']);
    await retainTerminalRun('Failed report', undefined, 'failed');
    const wake = await bridge.takeWorkerUpdate('parent_session', signal);
    expect(wake?.update).toMatchObject({ ownerState: 'failed', result: 'Failed report' });
    wake!.acknowledgeAccepted();
    const remaining = await bridge.prepareWorkerUpdates('parent_session', { signal });
    expect(remaining.map(item => item.update.result)).toEqual(['Successful report']);
    const waiting = new AbortController();
    const changed = bridge.waitForWorkerUpdateChange('parent_session', waiting.signal);
    waiting.abort();
    expect(await changed).toBe(false);
  });

  it('does not interpret a foreign-workspace final result as scoped deliverables', async () => {
    const finalResult = { summary: 'Foreign file', deliverables: [{ kind: 'workspace_file', sessionId: 'foreign', path: 'result.md' }] };
    await retainTerminalRun(finalResult);
    const bridge = await createBridge();
    const update = (await readNaturalWorkerUpdate(bridge, new AbortController().signal))?.update;
    expect(update).not.toHaveProperty('deliverables');
    expect(update?.result).toBe(finalResult.summary);
  });
  it('projects a follow-up summary while keeping the full result inspectable through its Run', async () => {
    const result = { status: 'succeeded', summary: 'The cursor skips the first page.', runId: 'retained-run' };
    const run = await retainTerminalRun(result);
    const bridge = await createBridge();
    const update = (await readNaturalWorkerUpdate(bridge, new AbortController().signal))?.update;
    expect(update).toMatchObject({ result: 'The cursor skips the first page.', canInspect: true,
      transcriptPointer: { kind: 'execution_run', sessionId: 'parent_session', runId: 'retained-run' } });
    expect(run.latestToolResult).toEqual(result);
  });
  it('carries scoped deliverables from the final profile result through completion and restart', async () => {
    const deliverables = [{ kind: 'workspace_file', sessionId: 'parent_session', path: 'docs/result.md' }, { kind: 'artifact', artifactId: 'document-1' }];
    await retainTerminalRun({ summary: 'Ready for review', deliverables });
    const bridge = await createBridge();
    expect((await readNaturalWorkerUpdate(bridge, new AbortController().signal))?.update).toMatchObject({ result: 'Ready for review', deliverables });
    const restarted = await createBridge();
    expect((await readNaturalWorkerUpdate(restarted, new AbortController().signal))?.update).toMatchObject({ result: 'Ready for review', deliverables });
  });
  it('pulls the scoped retained result without consuming it and keeps pending custody private through GC', async () => {
    const run = await retainTerminalRun();
    const bridge = await createBridge();
    const signal = new AbortController().signal;
    const input = await readNaturalWorkerUpdate(bridge, signal);
    expect(input).toMatchObject({ update: {
      workerKind: 'execution_run', workerId: run.runId, ownerState: 'succeeded',
      result: 'The requested change is implemented.', engine: { agentId: 'acme.actual', modelId: 'actual-model' },
    } });
    expect((await readNaturalWorkerUpdate(bridge, signal))?.localId).toBe(input?.localId);
    if (!input) throw new Error('Expected the retained worker input');
    const prepared = await bridge.prepareWorkerUpdates('parent_session', { signal });
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.localId).toBe(input.localId);
    expect((await readNaturalWorkerUpdate(bridge, signal))?.localId).toBe(input.localId);
    expect(await bridge.takeWorkerUpdate('different_session', signal)).toBeNull();
    const markerEntry = `run-${createHash('sha256').update(JSON.stringify([run.runId])).digest('hex')}.json`;
    expect(readFileSync(join(directory, 'tmp', 'daemon-execution-runs', markerEntry), 'utf8')).not.toContain('The requested change');
    const markerDir = join(directory, 'tmp', 'daemon-execution-runs');
    const custodyEntry = readdirSync(markerDir).find((name) => name.startsWith('worker-update-') && name.endsWith('.sealed'));
    if (!custodyEntry) throw new Error('Expected protected terminal custody');
    expect(readFileSync(join(markerDir, custodyEntry), 'utf8')).not.toContain('The requested change');
    if (process.platform !== 'win32') {
      expect(statSync(join(markerDir, custodyEntry)).mode & 0o777).toBe(0o600);
    }
    const { listExecutionRunMarkers, gcExecutionRunMarkers } = await import('@/daemon/executionRunRegistry');
    expect((await listExecutionRunMarkers())[0]).not.toHaveProperty('pendingWorkerUpdateCiphertext');
    expect(await gcExecutionRunMarkers({
      nowMs: 1_800_000_000_000, terminalTtlMs: 0,
      isPidAlive: () => false, isPidSafeHappyProcess: () => false,
    })).toEqual({ removedRunIds: [] });
  });

  it('redelivers retained terminal state across restart until acceptance ACK reaches disk', async () => {
    const run = await retainTerminalRun();
    const registry = await import('@/daemon/executionRunRegistry');
    const [pending] = await registry.readPendingExecutionRunWorkerUpdates();
    if (!pending) throw new Error('Expected retained terminal observation');
    const markerDir = join(directory, 'tmp', 'daemon-execution-runs');
    const entry = readdirSync(markerDir).find((name) => name.startsWith('worker-update-') && name.endsWith('.sealed'));
    if (!entry) throw new Error('Expected terminal custody');
    const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
    writeFileSync(join(markerDir, entry), storage.sealJson({ purpose: 'execution_run_worker_update', value: {
      ...pending, future: true, update: { ...pending.update, future: true,
        engine: { ...pending.update.engine, future: true }, transcriptPointer: { ...pending.update.transcriptPointer, future: true } },
    } }));
    // A retry compares known immutable custody, never echoes additive stored fields.
    await registry.retainExecutionRunWorkerUpdate(pending);
    const bridge = await createBridge();
    const signal = new AbortController().signal;
    const original = await readNaturalWorkerUpdate(bridge, signal);
    const restarted = await createBridge();
    const replay = await readNaturalWorkerUpdate(restarted, signal);
    expect(replay?.localId).toBe(original?.localId);
    expect(replay?.update.workerId).toBe(run.runId);
    expect(JSON.stringify(replay?.update)).not.toContain('future');
    replay?.acknowledgeAccepted();
    expect(await readNaturalWorkerUpdate(restarted, signal)).toBeNull();
    const afterAck = await createBridge();
    expect(await readNaturalWorkerUpdate(afterAck, signal)).toBeNull();
  });

  it('retains each same-run completion across restart and ACKs only the accepted observation', async () => {
    await retainTerminalRun('First accepted run result');
    await retainTerminalRun('Second accepted run result');
    const bridge = await createBridge();
    const signal = new AbortController().signal;
    const prepared = await bridge.prepareWorkerUpdates('parent_session', { signal });
    expect(prepared.map((input) => input.update.result).sort()).toEqual([
      'First accepted run result', 'Second accepted run result',
    ]);
    expect(new Set(prepared.map((input) => input.localId)).size).toBe(2);

    const accepted = prepared.find((input) => input.update.result === 'First accepted run result');
    if (!accepted) throw new Error('Expected the first pending completion');
    accepted.acknowledgeAccepted();
    expect((await readNaturalWorkerUpdate(bridge, signal))?.update.result).toBe('Second accepted run result');

    const restarted = await createBridge();
    expect((await readNaturalWorkerUpdate(restarted, signal))?.update.result).toBe('Second accepted run result');
  });

  it('keeps pending completion custody when the daemon removes its public run marker', async () => {
    const run = await retainTerminalRun();
    const { removeExecutionRunMarker, listExecutionRunMarkers } = await import('@/daemon/executionRunRegistry');
    await removeExecutionRunMarker(run.runId);
    expect(await listExecutionRunMarkers()).toEqual([]);
    const bridge = await createBridge();
    const signal = new AbortController().signal;
    const pending = await readNaturalWorkerUpdate(bridge, signal);
    expect(pending?.update.result).toBe('The requested change is implemented.');
    pending?.acknowledgeAccepted();
    expect(await readNaturalWorkerUpdate(bridge, signal)).toBeNull();
    const restarted = await createBridge();
    expect(await readNaturalWorkerUpdate(restarted, signal)).toBeNull();
  });

  it('does not replay an accepted observation when another completion publishes during its ACK', async () => {
    let pauseRead = false;
    let oldCustodyPath = '';
    let readReached!: () => void;
    let releaseRead!: () => void;
    const reached = new Promise<void>((resolve) => { readReached = resolve; });
    const released = new Promise<void>((resolve) => { releaseRead = resolve; });
    // Pause a real filesystem read after its bytes are obtained, as another process's ACK deletes custody.
    filesystemBoundary.onOpen = (path, handle) => {
      if (pauseRead && path === oldCustodyPath) {
        pauseRead = false;
        const originalRead = handle.readFile.bind(handle);
        vi.spyOn(handle, 'readFile').mockImplementation(async (...readArgs) => {
          const contents = await originalRead(...readArgs);
          readReached();
          await released;
          return contents;
        });
      }
    };
    try {
      const run = await retainTerminalRun('Previously completed result');
      const bridge = await createBridge();
      const signal = new AbortController().signal;
      const accepted = await readNaturalWorkerUpdate(bridge, signal);
      if (!accepted) throw new Error('Expected retained input');
      const markerDir = join(directory, 'tmp', 'daemon-execution-runs');
      const entry = readdirSync(markerDir).find((name) => name.startsWith('worker-update-') && name.endsWith('.sealed'));
      if (!entry) throw new Error('Expected old completion custody');
      oldCustodyPath = join(markerDir, entry);

      // Seed the real bridge's owner state; provider runtime construction is outside this recovery test.
      const runs = Reflect.get(bridge, 'runs') as Map<string, ExecutionRunState>;
      runs.set(run.runId, { ...run, status: 'running' });
      const finish = Reflect.get(bridge, 'finishRun') as (
        runId: string, next: { status: 'succeeded'; finishedAtMs: number }, result: { output: string },
      ) => Promise<void>;
      pauseRead = true;
      const finishing = finish.call(bridge, run.runId, { status: 'succeeded', finishedAtMs: 3 }, { output: 'Newly completed result' });
      const snapshotPaused = await Promise.race([reached.then(() => true), finishing.then(() => false)]);
      pauseRead = false;
      accepted.acknowledgeAccepted();
      const afterAck = await bridge.prepareWorkerUpdates('parent_session', { signal });
      expect(afterAck.map((input) => input.update.result)).toEqual(snapshotPaused ? [] : ['Newly completed result']);
      releaseRead();
      await finishing;
      const pending = await bridge.prepareWorkerUpdates('parent_session', { signal });
      expect(pending.map((input) => input.update.result)).toEqual(['Newly completed result']);
    } finally {
      releaseRead();
      filesystemBoundary.onOpen = null;
    }
  });

  it('keeps an over-bound result inspectable through its transcript pointer', async () => {
    const run = await retainTerminalRun('result '.repeat(1_500));
    const bridge = await createBridge();
    const input = await readNaturalWorkerUpdate(bridge, new AbortController().signal);
    expect(input?.update).toMatchObject({ truncated: true, transcriptPointer: { kind: 'execution_run', sessionId: 'parent_session', runId: run.runId } });
    expect(input?.update.result?.length).toBe(8_000);
  });

  it('keeps corrupt sealed custody retained rather than disclosing or collecting it', async () => {
    await retainTerminalRun('Private retained output', 'invalid-sealed-payload');
    const bridge = await createBridge();
    const signal = new AbortController().signal;
    expect(await bridge.takeWorkerUpdate('parent_session', signal)).toBeNull();
    const { gcExecutionRunMarkers } = await import('@/daemon/executionRunRegistry');
    expect(await gcExecutionRunMarkers({
      nowMs: 1_800_000_000_000, terminalTtlMs: 0,
      isPidAlive: () => false, isPidSafeHappyProcess: () => false,
    })).toEqual({ removedRunIds: [] });
    await retainTerminalRun('Private retained output');
    const repaired = await createBridge();
    expect((await readNaturalWorkerUpdate(repaired, signal))?.update.result).toBe('Private retained output');
  });
});
