import { describe, expect, it } from 'vitest';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerSessionControlHandlers } from '@/rpc/handlers/sessionControls';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionPendingQueueWakeCapabilityResponseV1Schema, SessionPendingQueueWakeResponseV1Schema } from '@happier-dev/protocol/sessions/pending/sessionPendingQueueWakeV1';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createWorkflowOriginContextInputPort } from '../contextOnly/workflowOriginInput';
import { publishSessionFollowWakeInvalidation } from '../follow/sessionFollowWakeSignal';
import { createSessionProviderInputConsumer } from './sessionProviderInputConsumer';

describe('retained Pending input and context-only wakes', () => {
  it('parks behind rejected Pending custody, then rejoins the retained workflow wake after withdrawal', async () => {
    const source = createWorkflowOriginContextInputPort({
      accountId: 'account', originSessionId: 'session', machineId: 'machine',
      // Workflow storage is a daemon/network boundary. There are no workflow rows
      // in this Session; the real origin port still owns its wake generation.
      storage: { execute: async () => ({ runs: [] }) },
      resolveEncryption: async () => { throw new Error('No workflow row to decrypt'); },
      readDispatchFact: async () => 'not_dispatched', onDispatchedInput() {},
      onError: error => { throw error; },
    });
    let pending = true;
    let readyWakeReads = 0;
    const metadataWaiters = new Set<() => void>();
    const controller = new AbortController();
    const queue = new MessageQueue2<{ id: string }, string>(() => 'mode');
    const consumer = createSessionProviderInputConsumer({
      messageQueue: queue,
      session: {
        hasPendingProviderInput: () => pending,
        waitForMetadataUpdate: signal => new Promise<boolean>(resolve => {
          const finish = (changed: boolean) => {
            metadataWaiters.delete(wake);
            signal?.removeEventListener('abort', abort);
            resolve(changed);
          };
          const wake = () => finish(true);
          const abort = () => finish(false);
          metadataWaiters.add(wake);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        }),
      },
      beforePendingMaterialize: () => false,
      waitForContextOnlyInputChange: async signal => {
        const changed = await source.waitForChange(signal);
        // Test diagnostic only: stop the old microtask spin before it can starve
        // Vitest's own deadline and the simulated incoming control request.
        if (changed && ++readyWakeReads > 20) throw new Error('Retained context wake starved runtime controls');
        return changed;
      },
      takeContextOnlyInput: async signal => {
        await source.take(signal);
        queue.pushImmediate('successor after withdrawal', { id: 'mode' });
        return null;
      },
    });
    publishSessionFollowWakeInvalidation();
    const next = consumer.waitForNextInput({ abortSignal: controller.signal });
    void next.catch(() => {});
    const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain' });
    registerSessionControlHandlers(rpc, { sessionRuntimeControls: {
      wakePendingMaterialization: () => { for (const wake of [...metadataWaiters]) wake(); },
    } });
    try {
      // Incoming control IO must run while the rejected row remains Pending.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(SessionPendingQueueWakeCapabilityResponseV1Schema.parse(await rpc.invokeLocal(
        SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1, {},
      ))).toMatchObject({ ok: true, method: SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1 });
      expect(SessionPendingQueueWakeResponseV1Schema.parse(await rpc.invokeLocal(
        SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1, { protocolVersion: 1 },
      ))).toEqual({ ok: true, result: 'wake_published' });
      // A wake never authorizes context-only consumption past Pending custody.
      await new Promise<void>(resolve => setImmediate(resolve));
      pending = false;
      await rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1, { protocolVersion: 1 });
      await expect(next).resolves.toMatchObject({ message: 'successor after withdrawal' });
    } finally {
      controller.abort();
      await next;
    }
  });
});
