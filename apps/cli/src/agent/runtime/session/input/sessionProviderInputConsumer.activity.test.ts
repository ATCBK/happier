import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { RuntimeActivitySnapshotTail } from '@/api/session/sessionClientPort';
import { createDeferred } from '@/testkit/async/deferred';
import { createSessionProviderInputConsumer } from './sessionProviderInputConsumer';
import { buildSessionAgentActivityHeadline } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineBuild';
import { createHostSubagentStore } from '@/session/subagents/hostSubagentStore';
import type { AgentState } from '@/api/types';
import type { SessionAgentActivityEntryV1 } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityEntryV1';

function idleTail(): RuntimeActivitySnapshotTail {
  return { sequence: 1, custody: null, settlement: {
    identity: { mutationKey: 'runtime-activity:s1', admissionOrder: 1 },
    desiredValue: { state: 'idle', activeCount: 0 }, result: 'applied',
    committedProjection: { state: 'idle', activeCount: 0, observedAt: 1, revision: 2 }, committedRevision: 2,
  } };
}

describe('Session input live-work observation', () => {
  it('counts workflow agents without counting their containing run as another subagent', async () => {
    const entries: SessionAgentActivityEntryV1[] = [
      { entryId: 'run', kind: 'workflow_run', title: 'Run', status: 'running', updatedAt: 1 },
      { entryId: 'a', parentId: 'run', kind: 'workflow_agent', title: 'A', status: 'running', updatedAt: 1 },
      { entryId: 'b', parentId: 'run', kind: 'workflow_agent', title: 'B', status: 'running', updatedAt: 1 },
    ];
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: async () => false, getAgentStateSnapshot: () => ({}),
      getMetadataSnapshot: () => ({ sessionAgentActivityHeadlineV1: buildSessionAgentActivityHeadline({ backendId: 'test', updatedAt: 1, entries }) }),
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }), readRuntimeActivitySnapshotTail: idleTail,
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    expect(await consumer.readLiveWork()).toMatchObject({ agents: 'active', agentsActiveCount: 2 });
    entries.splice(1);
    expect(await consumer.readLiveWork()).toMatchObject({ agents: 'active', agentsActiveCount: 0 });
  });
  it('keeps unavailable Agent state unknown and derives pending requests despite nullable capabilities', async () => {
    let agentState: AgentState | null = null;
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: async () => false, getMetadataSnapshot: () => ({}),
      getAgentStateSnapshot: () => agentState,
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }), readRuntimeActivitySnapshotTail: idleTail,
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    expect(await consumer.readLiveWork()).toMatchObject({ attention: 'unknown' });
    expect((await consumer.readLiveWork()).settledAt).toBeUndefined();
    agentState = { capabilities: { inFlightSteer: null, askUserQuestionAnswersInPermission: null } };
    expect(await consumer.readLiveWork()).toMatchObject({ attention: 'settled', settledAt: expect.any(Number) });
    agentState = { ...agentState, requests: {
      question: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 1 },
    } };
    expect(await consumer.readLiveWork()).toMatchObject({ attention: 'active' });
    agentState = { ...agentState, completedRequests: {
      question: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 1, completedAt: 2, status: 'approved' },
    } };
    expect(await consumer.readLiveWork()).toMatchObject({ attention: 'settled', settledAt: expect.any(Number) });
  });
  it('does not retain a settlement anchor through a malformed idle observation', async () => {
    let tail = idleTail();
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: async () => false, getMetadataSnapshot: () => ({}), getAgentStateSnapshot: () => ({}),
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }), readRuntimeActivitySnapshotTail: () => tail,
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    expect((await consumer.readLiveWork()).settledAt).toBe(1);
    tail = { ...tail, settlement: { ...tail.settlement!, committedProjection: { ...tail.settlement!.committedProjection, observedAt: NaN } } };
    expect((await consumer.readLiveWork()).settledAt).toBeUndefined();
  });
  it('observes live host subagents, fails closed on malformed headlines, and releases the host subscription', async () => {
    const store = createHostSubagentStore({ maxListResults: 1 });
    let metadata: unknown = {};
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: async () => false, getMetadataSnapshot: () => metadata, getAgentStateSnapshot: () => ({}),
      readSubagentLiveWork: () => store.readLiveWork('parent'), subscribeSubagentLiveWork: listener => store.subscribeLiveWork('parent', listener),
      readRuntimeActivitySnapshotTail: idleTail,
      getPendingQueueState: () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    const reads: Array<ReturnType<typeof consumer.readLiveWork>> = [];
    const unsubscribe = consumer.subscribeLiveWork(() => reads.push(consumer.readLiveWork()));
    await store.upsert({ actor: { kind: 'host' }, input: { id: 'child', parentSessionId: 'parent', origin: 'agent', kind: 'native' } });
    expect(await reads.at(-1)).toMatchObject({ agents: 'active', agentsActiveCount: 1 });
    await store.complete({ actor: { kind: 'host' }, id: 'child', parentSessionId: 'parent' });
    expect(await reads.at(-1)).toMatchObject({ agents: 'settled', settledAt: expect.any(Number) });
    metadata = { sessionAgentActivityHeadlineV1: { v: 1, backendId: 'test', updatedAt: 1, activeEntries: [{}] } };
    expect(await consumer.readLiveWork()).toMatchObject({ agents: 'unknown' });
    unsubscribe();
    const length = reads.length;
    await store.upsert({ actor: { kind: 'host' }, input: { id: 'next', parentSessionId: 'parent', origin: 'agent', kind: 'native' } });
    expect(reads).toHaveLength(length);
  });
  it('requires fresh known Pending state and an exact committed idle tail', async () => {
    let tail = idleTail();
    let pendingCount = 0;
    let known = false;
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<string>(() => 'mode'),
      session: {
        waitForMetadataUpdate: async () => false,
        readRuntimeActivitySnapshotTail: () => tail,
        readPendingQueueStateForLiveWork: async () => known
          ? { known: true, pendingCount, pendingBlockedCount: pendingCount, pendingVersion: 1 }
          : { known: false },
      },
    });
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ session: 'settled', input: 'unknown', agents: 'unknown', attention: 'unknown' });
    known = true;
    pendingCount = 1;
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ session: 'settled', input: 'active' });
    pendingCount = 0;
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ session: 'settled', input: 'settled' });
    tail = { ...tail, custody: { identity: { mutationKey: 'runtime-activity:s1', admissionOrder: 2 },
      value: { state: 'idle', activeCount: 0 } } };
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ session: 'unknown', input: 'settled' });
    tail = { ...idleTail(), settlement: { ...idleTail().settlement!, committedRevision: 3 } };
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ session: 'unknown', input: 'settled' });
  });

  it('keeps preparation and held input busy through real dispatch settlement', async () => {
    const queue = new MessageQueue2<string>(() => 'mode');
    const dispatch = createDeferred<void>();
    const consumer = createSessionProviderInputConsumer({ messageQueue: queue, session: {
      waitForMetadataUpdate: async () => false,
      readRuntimeActivitySnapshotTail: idleTail,
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    queue.pushImmediate('accepted input', 'mode');
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
    await consumer.enforceProviderInputAdmission({ kind: 'action_required', reason: 'group_unavailable', serviceId: 'service', groupId: 'group' });
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
    await consumer.clearProviderInputAdmission({ serviceId: 'service', groupId: 'group' });
    await consumer.waitForNextInput({ abortSignal: new AbortController().signal });
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
    const running = consumer.runProviderInputDispatch({ abortSignal: new AbortController().signal, dispatch: () => dispatch.promise });
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
    dispatch.resolve();
    await running;
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
    consumer.releaseInputBatch();
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'settled' });
  });

  it('cannot turn a failed fresh Pending query into settled input', async () => {
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: async () => false,
      readRuntimeActivitySnapshotTail: idleTail,
      readPendingQueueStateForLiveWork: async () => { throw new Error('transport unavailable'); },
    } });
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'unknown' });
  });

  it('transfers queue custody before notifying observers and releases the last subscription', async () => {
    const queue = new MessageQueue2<string>(() => 'mode');
    const consumer = createSessionProviderInputConsumer({ messageQueue: queue, session: {
      waitForMetadataUpdate: async () => false,
      readRuntimeActivitySnapshotTail: idleTail,
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    const reads: Array<ReturnType<typeof consumer.readLiveWork>> = [];
    const unsubscribe = consumer.subscribeLiveWork(() => { reads.push(consumer.readLiveWork()); });
    queue.pushImmediate('accepted', 'mode');
    await consumer.waitForNextInput({ abortSignal: new AbortController().signal });
    expect((await Promise.all(reads)).every(read => read.input === 'active')).toBe(true);
    consumer.releaseInputBatch();
    await expect(reads.at(-1)).resolves.toMatchObject({ input: 'settled' });
    unsubscribe();
    const lastRead = reads.at(-1);
    queue.pushImmediate('next', 'mode');
    expect(reads.at(-1)).toBe(lastRead);
  });

  it('does not notify live-work observers for an empty pending drain', async () => {
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: async () => false,
      getPendingQueueState: () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
      readRuntimeActivitySnapshotTail: idleTail,
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    let notifications = 0;
    const unsubscribe = consumer.subscribeLiveWork(() => { notifications += 1; });

    await consumer.drainPending();

    expect(notifications).toBe(0);
    unsubscribe();
  });
});

describe('Session input live-work notification stability', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('does not re-notify the observer that only re-read an unchanged host', async () => {
    // The daemon re-reads live work on every notification, and each Session snapshot
    // refresh wakes the metadata observer. A read the pending drain could not prove
    // (`known: false`) must not make the next unchanged observation look like new work.
    vi.useFakeTimers({ toFake: ['Date'] });
    const metadataWaiters: Array<() => void> = [];
    const wakeMetadata = () => { for (const wake of metadataWaiters.splice(0)) wake(); };
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: signal => new Promise<boolean>(resolve => {
        metadataWaiters.push(() => resolve(true));
        signal?.addEventListener('abort', () => resolve(false), { once: true });
      }),
      getMetadataSnapshot: () => ({}), getAgentStateSnapshot: () => ({}),
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }), readRuntimeActivitySnapshotTail: idleTail,
      getPendingQueueState: () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
      readPendingQueueStateForLiveWork: async () => ({ known: false }),
    } });
    let notifications = 0;
    const unsubscribe = consumer.subscribeLiveWork(() => {
      notifications += 1;
      if (notifications > 20) return;
      vi.setSystemTime(Date.now() + 500);
      void consumer.readLiveWork().then(wakeMetadata);
    });
    await consumer.readLiveWork();
    wakeMetadata();
    for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
    unsubscribe();
    expect(notifications).toBeLessThanOrEqual(1);
  });
});
