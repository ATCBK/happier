import { describe, expect, it, vi } from 'vitest';
import axios, { AxiosError, AxiosHeaders } from 'axios';
import {
  createWorkflowAccountRunActionOwner,
  materializeWorkflowAcceptedSnapshotV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1,
  WorkflowDefinitionV1Schema,
} from '@happier-dev/protocol';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { createProductionWorkflowRunCoordinator, DurableWorkflowCoordinatorStore } from './production';
import { workflowInvocationKey } from './coordinator';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import { executeClaimedRun } from '@/daemon/automation/automationRunExecutor';
import { createAutomationClaimClient } from '@/daemon/automation/automationClaimClient';
import { WORKFLOW_AUTHORIZATION_NOT_CURRENT_ABORT_REASON, WORKFLOW_CANCEL_REQUESTED_ABORT_REASON } from './coordinator';

const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
const accountId = 'account-1';
const machineId = 'machine-1';
const rootId = 'recovered-root';
const encryption = { witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null },
  runCrypto: { mode: 'plain' as const } };

async function interruptedRoot(lifecycle: 'pending' | 'running' | 'needs_attention', claimOrigin: 'direct' | 'automation' = 'direct') {
  const origin = claimOrigin === 'direct' ? { kind: 'direct' as const }
    : { kind: 'automation' as const, automationId: 'automation-1' };
  const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], blocks: [
    { kind: 'wait', id: 'check', document: { text: 'Review if needed', references: [], attachments: [] },
      onlyWhen: { kind: 'compare', operator: 'eq', left: { kind: 'literal', value: true },
        right: { kind: 'literal', value: false } } },
  ] });
  const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
    context: { source: origin.kind === 'direct' ? { kind: 'inline' } : origin, inputs: {}, machineId, executionTarget: { kind: 'detached_run' },
      workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
      ...(origin.kind === 'direct' ? { origin } : {}), authorization: { principal: { kind: 'host' } } },
    admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
  if (!accepted.ok) throw new Error(accepted.error.code);
  const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
    mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot,
  }));
  const storage = createWorkflowRunStorageTestkit({ runId, machineId, origin, acceptedEnvelope });
  const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: rootId,
    nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
  await storage.execute({ operation: 'initialize', runId, expectedRevision: 0,
    checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint })),
    rootInvocation: { id: rootId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId,
        recordId: rootId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', attempt: '0',
        invocationPath: { blockId: '$root', scope: [] }, logicalInvocationRecordId: rootId },
    })) } });
  const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0,
    rootRecordId: rootId, checkpoint, encryption, storage, revision: storage.run().revision });
  const rootKey = workflowInvocationKey({ runId, blockId: '$root', scope: [], attempt: 0 });
  await store.commitFact({ key: rootKey, lifecycle, reason: 'storage_unavailable', reasonMessage: 'Storage failed before recovery.' });
  const reader = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId, storage,
    definitions: { get: async () => { throw new Error('unexpected_definition_read'); } },
    resolveEncryption: async () => ({ kind: 'available', witness: encryption.witness }),
    normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
    randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
  });
  const readRoot = async () => WorkflowActionOutputSchemasV1['workflow.run.invocations.get'].parse(await reader.execute({
    actionId: 'workflow.run.invocations.get', input: { runId, invocationId: rootId }, context: {},
  })).invocation;
  return { acceptedEnvelope, storage, store, rootKey, readRoot };
}

function recoveredCoordinator(storage: ReturnType<typeof createWorkflowRunStorageTestkit>, isAcceptedAuthorizationCurrent = async () => true) {
  return createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId, storage,
    execution: { credentials: { token: 'token', encryption: null }, serverId: 'server-1',
      machineAdmissionTransport: async () => { throw new Error('unexpected_session_input'); },
      resolveExistingSessionConversation: async () => { throw new Error('unexpected_session'); },
      detachedRun: { actionExecutor: { execute: async () => { throw new Error('unexpected_detached_input'); } },
        buildActionContext: () => ({ surface: 'cli', authority: 'account_automation' }) } },
    onCommittedTransition: async () => {},
    resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
    resolveAccountEncryption: async () => ({ kind: 'available', witness: encryption.witness }),
    isAcceptedAuthorizationCurrent,
  });
}

async function heldHeartbeatRun(options: { holdAfterOpen?: boolean; delayedClaimOrigin?: 'direct' | 'automation' } = {}) {
  const h = await interruptedRoot('pending', options.delayedClaimOrigin);
  let releaseRead = () => {};
  let readStarted = () => {};
  const reading = new Promise<void>(resolve => { readStarted = resolve; });
  const delayedRead = new Promise<void>(resolve => { releaseRead = resolve; });
  let held = false;
  let signal: AbortSignal | undefined;
  let authorizationCurrent = true;
  let authorizationFailure: Error | undefined;
  const worker = new AbortController();
  const coordinate = recoveredCoordinator({ ...h.storage, execute: async (operation, request) => {
    signal ??= request?.signal;
    if (!held && (options.holdAfterOpen
      ? operation.operation === 'invocations.fact' && operation.lifecycle === 'running'
      : operation.operation === 'get')) {
      held = true;
      readStarted();
      await delayedRead;
      signal?.throwIfAborted();
    }
    return await h.storage.execute(operation, request);
  } }, async () => {
    if (authorizationFailure) throw authorizationFailure;
    return authorizationCurrent;
  });
  const claimClient = createAutomationClaimClient({ token: 'test-token', createPublisherHeader: async () => null });
  const run = { id: runId, attempt: options.delayedClaimOrigin ? 1 : 0, revision: h.storage.run().revision,
    leaseExpiresAt: Date.now() + 30_000, workflowAcceptedSnapshotEnvelope: h.acceptedEnvelope, triggerId: null };
  let claimed: Parameters<typeof executeClaimedRun>[0]['claimed'] = {
    protocol: 'v3', automation: null, accountCurrentness: encryption.witness,
    run: { ...run, automationId: null, origin: { kind: 'direct' } },
  };
  if (options.delayedClaimOrigin) {
    const automation = options.delayedClaimOrigin === 'automation' ? { id: 'automation-1', name: 'Recovery', enabled: true } : null;
    // Only the HTTP delivery and clock are faked. The strict claim parser,
    // private projection, executor and Workflow coordinator remain real.
    vi.spyOn(axios, 'post').mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 10_000);
      return { data: { accountCurrentness: encryption.witness, automation,
        run: { ...run, recipeKind: 'workflow-v2', triggerRetired: false,
          ...(automation ? { automationId: automation.id, executionInputEnvelope: '{}', automationEvidenceEnvelope: null,
            cause: { kind: 'manual', invokedAt: 0 } } : { automationId: null, origin: { kind: 'direct' } }),
        } } };
    });
    const response = await claimClient.claimRun({ machineId, leaseDurationMs: 30_000, scope: 'workflow' });
    if (!response.run) throw new Error('Expected the delayed successful claim');
    claimed = response;
  }
  const execution = executeClaimedRun({ machineId, heartbeatMs: 5_000, leaseDurationMs: 30_000,
    coordinateWorkflowRun: coordinate, claimClient, signal: worker.signal,
    claimed,
  });
  await Promise.race([reading, execution]);
  return { ...h, execution, releaseRead, worker, signal: () => signal,
    failAuthorizationRead: () => { authorizationFailure = heartbeatHttpFailure(503); },
    revokeAuthorization: () => { authorizationCurrent = false; } };
}

function heartbeatHttpFailure(status?: number) {
  return new AxiosError('heartbeat failed', status === undefined ? 'ECONNABORTED' : 'ERR_BAD_RESPONSE', undefined, undefined,
    status === undefined ? undefined : { status, statusText: 'Refused', headers: {}, config: { headers: new AxiosHeaders() },
      data: { error: 'automation_run_not_found_or_not_claimed' } });
}

describe('Workflow root recovery', () => {
  it.each(['direct', 'automation'] as const)('preserves the server expiry after a delayed %s claim and failed, pending or successful renewal', async origin => {
    for (const mode of ['failed', 'pending', 'renewed'] as const) {
      vi.useFakeTimers(); vi.setSystemTime(0);
      let finishHeartbeat = () => {};
      const pendingHeartbeat = new Promise<{ data: { ok: true; leaseExpiresAt: number } }>(resolve => {
        finishHeartbeat = () => resolve({ data: { ok: true, leaseExpiresAt: 60_000 } });
      });
      const post = vi.spyOn(axios, 'post').mockRejectedValue(heartbeatHttpFailure());
      let h: Awaited<ReturnType<typeof heldHeartbeatRun>> | undefined;
      try {
        h = await heldHeartbeatRun({ delayedClaimOrigin: origin });
        expect(Date.now()).toBe(10_000);
        if (mode === 'pending') post.mockReturnValue(pendingHeartbeat);
        if (mode === 'renewed') post.mockResolvedValueOnce({ data: { ok: true, leaseExpiresAt: 45_000 } });
        await vi.advanceTimersByTimeAsync(19_999);
        expect(h.signal()?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.signal()?.aborted).toBe(mode !== 'renewed');
        if (mode === 'renewed') {
          await vi.advanceTimersByTimeAsync(14_999);
          expect(h.signal()?.aborted).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(h.signal()?.aborted).toBe(true);
        }
        finishHeartbeat(); await vi.advanceTimersByTimeAsync(0);
        expect(h.signal()?.aborted).toBe(true);
        expect(h.storage.run().state).not.toBe('succeeded');
      } finally {
        finishHeartbeat(); h?.worker.abort(); h?.releaseRead(); await h?.execution;
        post.mockRestore(); vi.useRealTimers();
      }
    }
  });

  it('lease heartbeat tolerates a transient failure on the first renewal after a successful claim', async () => {
    vi.useFakeTimers();
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => ({ data: { ok: true, leaseExpiresAt: Date.now() + 30_000 } }))
      .mockRejectedValueOnce(heartbeatHttpFailure());
    let h: Awaited<ReturnType<typeof heldHeartbeatRun>> | undefined;
    try {
      h = await heldHeartbeatRun();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.signal()?.aborted).toBe(false);
      h.releaseRead(); await h.execution;
      expect(h.storage.run().state).toBe('succeeded');
    } finally {
      h?.worker.abort(); h?.releaseRead(); await h?.execution;
      post.mockRestore(); vi.useRealTimers();
    }
  });

  it('lease heartbeat recovers after a slow request times out within the confirmed lease', async () => {
    vi.useFakeTimers();
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => ({ data: { ok: true, leaseExpiresAt: Date.now() + 30_000 } }));
    const h = await heldHeartbeatRun();
    try {
      // The claim client's existing HTTP deadline is 15s, independent of the
      // 30s lease. The request stays pending across several heartbeat ticks.
      post.mockImplementationOnce(() => new Promise((_, reject) => {
        setTimeout(() => reject(heartbeatHttpFailure()), 15_000);
      }));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(h.signal()?.aborted).toBe(false);
      h.releaseRead(); await h.execution;
      expect(h.storage.run().state).toBe('succeeded');
    } finally {
      h.worker.abort(); h.releaseRead(); await h.execution;
      post.mockRestore(); vi.useRealTimers();
    }
  });

  it.each([undefined, 503])('lease heartbeat tolerates transient HTTP failure (%s) and renews the same execution', async status => {
    vi.useFakeTimers();
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => ({ data: { ok: true, leaseExpiresAt: Date.now() + 30_000 } }));
    const h = await heldHeartbeatRun();
    try {
      post.mockRejectedValueOnce(heartbeatHttpFailure(status));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      post.mockRejectedValue(heartbeatHttpFailure());
      // Last success was at 10s: transient failures may not cut its lease short.
      await vi.advanceTimersByTimeAsync(29_999);
      expect(h.signal()?.aborted).toBe(false);
      h.releaseRead();
      await h.execution;
      expect(h.storage.run().state).toBe('succeeded');
      expect((await h.readRoot()).index.lifecycle).toBe('completed');
    } finally {
      h.worker.abort(); h.releaseRead(); await h.execution;
      post.mockRestore(); vi.useRealTimers();
    }
  });

  it.each(['failed', 'pending', 'renewed'] as const)('lease heartbeat aborts at the existing lease duration with a %s transport', async mode => {
    vi.useFakeTimers();
    let finishHeartbeat = () => {};
    const pendingHeartbeat = new Promise<{ data: { ok: true; leaseExpiresAt: number } }>(resolve => {
      finishHeartbeat = () => resolve({ data: { ok: true, leaseExpiresAt: Date.now() + 30_000 } });
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => ({ data: { ok: true, leaseExpiresAt: Date.now() + 30_000 } }));
    const h = await heldHeartbeatRun();
    try {
      post.mockRejectedValue(heartbeatHttpFailure());
      if (mode === 'pending') post.mockReturnValue(pendingHeartbeat);
      if (mode === 'renewed') post.mockResolvedValueOnce({ data: { ok: true, leaseExpiresAt: Date.now() + 35_000 } });
      const expiresAt = mode === 'renewed' ? 35_000 : 30_000;
      await vi.advanceTimersByTimeAsync(expiresAt - 1);
      expect(h.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.signal()?.aborted).toBe(true);
      finishHeartbeat();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.signal()?.aborted).toBe(true);
      h.releaseRead(); await h.execution;
      expect(h.storage.run().state).not.toBe('succeeded');
    } finally {
      finishHeartbeat(); h.worker.abort(); h.releaseRead(); await h.execution;
      post.mockRestore(); vi.useRealTimers();
    }
  });

  it.each([401, 403, 404])('lease heartbeat aborts immediately on definitive HTTP refusal (%s)', async status => {
    vi.useFakeTimers();
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => ({ data: { ok: true, leaseExpiresAt: Date.now() + 30_000 } }));
    const h = await heldHeartbeatRun();
    try {
      post.mockRejectedValue(heartbeatHttpFailure(status));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.signal()?.aborted).toBe(true);
    } finally {
      h.worker.abort(); h.releaseRead(); await h.execution;
      post.mockRestore(); vi.useRealTimers();
    }
  });

  it.each(['worker', 'authorization', 'cancel'] as const)('lease heartbeat preserves %s aborts', async cause => {
    vi.useFakeTimers();
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => ({ data: { ok: true, leaseExpiresAt: Date.now() + 30_000 } }));
    const h = await heldHeartbeatRun({ holdAfterOpen: cause !== 'worker' });
    try {
      if (cause === 'worker') h.worker.abort('worker-retired');
      if (cause === 'authorization') h.revokeAuthorization();
      if (cause === 'cancel') h.storage.requestControl('cancel_requested');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.signal()?.aborted).toBe(true);
      expect(h.signal()?.reason).toBe(cause === 'worker' ? 'worker-retired'
        : cause === 'authorization' ? WORKFLOW_AUTHORIZATION_NOT_CURRENT_ABORT_REASON : WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
    } finally {
      h.worker.abort(); h.releaseRead(); await h.execution;
      post.mockRestore(); vi.useRealTimers();
    }
  });

  it('lease heartbeat retains fail-closed authorization reads after a successful renewal', async () => {
    vi.useFakeTimers();
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => ({ data: { ok: true, leaseExpiresAt: Date.now() + 30_000 } }));
    const h = await heldHeartbeatRun({ holdAfterOpen: true });
    try {
      h.failAuthorizationRead();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.signal()?.aborted).toBe(true);
    } finally {
      h.worker.abort(); h.releaseRead(); await h.execution;
      post.mockRestore(); vi.useRealTimers();
    }
  });

  it('retains observation through heartbeat transport failures until the confirmed lease expires, then recovers the same Run', async () => {
    const h = await interruptedRoot('pending');
    let releaseRead = () => {};
    let readStarted = () => {};
    const reading = new Promise<void>(resolve => { readStarted = resolve; });
    const delayedRead = new Promise<void>(resolve => { releaseRead = resolve; });
    let firstRead = true;
    let interruptedReadSignal: AbortSignal | undefined;
    const storageUnavailable = Object.assign(new Error('storage_unavailable'), {
      response: { status: 503, data: { error: 'storage_unavailable' } },
    });
    const coordinate = recoveredCoordinator({ ...h.storage, execute: async (operation, options) => {
      if (firstRead && operation.operation === 'get') {
        firstRead = false;
        interruptedReadSignal = options?.signal;
        readStarted();
        await delayedRead;
        throw storageUnavailable;
      }
      return await h.storage.execute(operation, options);
    } });
    const execute = (attempt: number, heartbeatRun: () => Promise<number>) => executeClaimedRun({
      machineId, heartbeatMs: 1_000, leaseDurationMs: 30_000,
      coordinateWorkflowRun: coordinate,
      claimClient: { heartbeatRun, failRun: async () => { throw new Error('unexpected_direct_failure'); } },
      claimed: { protocol: 'v3', automation: null, accountCurrentness: encryption.witness,
        run: { id: runId, automationId: null, attempt, leaseExpiresAt: Date.now() + 30_000, revision: h.storage.run().revision,
          origin: { kind: 'direct' }, triggerId: null, workflowAcceptedSnapshotEnvelope: h.acceptedEnvelope } },
    });
    vi.useFakeTimers();
    try {
      const firstAttempt = execute(0, async () => {
        throw Object.assign(new Error('heartbeat_timeout'), { code: 'ECONNABORTED' });
      });
      await reading;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(interruptedReadSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(28_999);
      expect(interruptedReadSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(interruptedReadSignal?.aborted).toBe(true);
      releaseRead();
      await firstAttempt;
      // Unavailable storage cannot settle an effect outcome. Preserve the same
      // pending snapshot for the server's existing expired-lease claim owner.
      expect(h.storage.rows()).toHaveLength(1);
      expect(h.storage.run()).toMatchObject({ state: 'running', workflowCustodyState: 'pending' });

      // The server claim service separately proves the expired-lease rejoin and
      // stale-attempt fence. Consume its next claim through the real executor.
      await execute(1, async () => Date.now() + 30_000);
      expect(h.storage.run()).toMatchObject({ state: 'succeeded', workflowCustodyState: 'settled' });
      expect((await h.readRoot()).index.lifecycle).toBe('completed');
    } finally {
      releaseRead();
      vi.useRealTimers();
    }
  });

  it.each(['pending', 'needs_attention', 'running'] as const)('clears the persisted root failure when a detached Run recovers from %s and succeeds', async lifecycle => {
    const h = await interruptedRoot(lifecycle);
    expect((await h.readRoot()).progress.reason?.code).toBe('storage_unavailable');
    const coordinate = recoveredCoordinator(h.storage);
    await expect(coordinate({ runId, attempt: 0, expectedRevision: h.storage.run().revision,
      acceptedEnvelope: h.acceptedEnvelope, accountCurrentness: encryption.witness })).resolves.toMatchObject({ state: 'succeeded' });
    expect(h.storage.run().state).toBe('succeeded');
    const root = await h.readRoot();
    expect(root.index.lifecycle).toBe('completed');
    expect(root.progress.reason).toBeUndefined();
  });

  it.each([false, true])('requires durable failure clearing after a lost root acknowledgment (committed=%s)', async committed => {
    const h = await interruptedRoot('running');
    const failure = new Error('root_recovery_acknowledgment_lost');
    let faultPending = true;
    const coordinate = recoveredCoordinator({ ...h.storage, execute: async operation => {
      if (faultPending && operation.operation === 'invocations.fact' && operation.invocationId === rootId
        && operation.lifecycle === 'running') {
        faultPending = false;
        if (committed) await h.storage.execute(operation);
        throw failure;
      }
      return await h.storage.execute(operation);
    } });
    const outcome = coordinate({ runId, attempt: 0, expectedRevision: h.storage.run().revision,
      acceptedEnvelope: h.acceptedEnvelope, accountCurrentness: encryption.witness });
    if (committed) {
      await expect(outcome).resolves.toMatchObject({ state: 'succeeded' });
      expect((await h.readRoot()).progress.reason).toBeUndefined();
    } else {
      await expect(outcome).rejects.toBe(failure);
      expect(h.storage.run().state).toBe('running');
      expect((await h.readRoot()).progress.reason?.code).toBe('storage_unavailable');
    }
    expect(faultPending).toBe(false);
  });

  it('records the current root failure after an earlier recoverable failure', async () => {
    const h = await interruptedRoot('needs_attention');
    await h.store.commitFact({ key: h.rootKey, lifecycle: 'needs_attention',
      reason: 'run_access_denied', reasonMessage: 'The resumed controller no longer has access.' });
    expect((await h.readRoot()).progress.reason).toEqual({ code: 'run_access_denied',
      message: 'The resumed controller no longer has access.' });
  });
});
