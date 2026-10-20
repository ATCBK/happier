import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import type { PermissionMode } from '@/api/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createDeferred } from '@/testkit/async/deferred';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { writeSessionPendingQueueHoldV1ToMetadata } from '@happier-dev/protocol';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';

import { waitForNextPermissionModeMessage } from './waitForNextPermissionModeMessage';

type QueueMode = { permissionMode: PermissionMode };
type PermissionModeSessionFixture = Pick<ApiSessionClient, 'waitForMetadataUpdate'> & {
  popPendingMessage?: () => Promise<boolean>;
  materializeNextPendingMessageSafely?: (opts?: {
    reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
    deliveryTiming?: 'after_runtime_idle';
  }) => Promise<MaterializeNextPendingResult>;
  getMetadataSnapshot?: () => unknown;
};

function createQueue(): MessageQueue2<QueueMode> {
  return new MessageQueue2<QueueMode>(() => 'hash');
}

const sessions: Pick<ReturnType<typeof createMutableApiSessionClientFixture>, 'close'>[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
});

function asSessionClient(session: PermissionModeSessionFixture): ApiSessionClient {
  const client = createMutableApiSessionClientFixture({ metadata: createTestMetadata() });
  sessions.push(client);
  return Object.assign(client, session);
}

describe('waitForNextPermissionModeMessage', () => {
  it('rejects when safe materialization reports terminal supervisor auth failure', async () => {
    const queue = createQueue();
    const popPendingMessage = vi.fn(async () => true);
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'deferred',
      reason: 'supervisor_auth_failed',
    }) satisfies MaterializeNextPendingResult);

    const session: PermissionModeSessionFixture = {
      popPendingMessage,
      materializeNextPendingMessageSafely,
      async waitForMetadataUpdate() {
        return false;
      },
    };

    await expect(waitForNextPermissionModeMessage({
        messageQueue: queue,
        abortSignal: new AbortController().signal,
        session: asSessionClient(session),
      })).rejects.toThrow(/auth/i);
    expect(popPendingMessage).not.toHaveBeenCalled();
  });

  it('does not materialize pending messages while pending edit hold metadata is active', async () => {
    const queue = createQueue();
    const abortController = new AbortController();
    const waitingForMetadata = createDeferred<void>();
    const metadataWithHold = writeSessionPendingQueueHoldV1ToMetadata(createTestMetadata(), {
      holdId: 'hold-1',
      localId: 'pending-1',
      updatedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    });
    const materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'materialized' as const,
      localId: 'pending-1',
      seq: 1,
      content: null,
    }));
    const popPendingMessage = vi.fn(async () => true);

    const resultPromise = waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: abortController.signal,
      session: asSessionClient({
        popPendingMessage,
        materializeNextPendingMessageSafely,
        getMetadataSnapshot: () => metadataWithHold,
        async waitForMetadataUpdate(abortSignal?: AbortSignal) {
          waitingForMetadata.resolve();
          return await new Promise<boolean>((resolve) => {
            abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
          });
        },
      }),
    });

    await waitingForMetadata.promise;
    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(popPendingMessage).not.toHaveBeenCalled();

    abortController.abort();
    await expect(resultPromise).resolves.toBeNull();
  });

  it('wakes on metadata update and then processes a pending-queue item', async () => {
    const queue = createQueue();
    const metadataUpdate = createDeferred<boolean>();
    let pendingText: string | null = null;
    const popPendingMessage = vi.fn(async () => {
      throw new Error('retired boolean materialization must not be called');
    });
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      if (!pendingText) return { type: 'no_pending' as const };
      const text = pendingText;
      pendingText = null;
      queue.pushImmediate(text, { permissionMode: 'default' });
      return {
        type: 'materialized' as const,
        localId: 'pending-from-metadata',
        seq: 1,
        content: null,
      };
    });

    const session: PermissionModeSessionFixture = {
      popPendingMessage,
      materializeNextPendingMessageSafely,
      async waitForMetadataUpdate() {
        return await metadataUpdate.promise;
      },
    };

    const resultPromise = waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: new AbortController().signal,
      session: asSessionClient(session),
      onMetadataUpdate: () => {
        pendingText = 'from-pending';
      },
    });

    metadataUpdate.resolve(true);
    const result = await resultPromise;

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);
    expect(popPendingMessage).not.toHaveBeenCalled();
    expect(result?.message).toBe('from-pending');
  });

  it('returns a queue message when one arrives while waiting', async () => {
    const queue = createQueue();
    const waitingForMetadata = createDeferred<void>();
    const session: PermissionModeSessionFixture = {
      async waitForMetadataUpdate(abortSignal?: AbortSignal) {
        waitingForMetadata.resolve();
        return await new Promise<boolean>((resolve) => {
          abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      },
    };

    const resultPromise = waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: new AbortController().signal,
      session: asSessionClient(session),
    });

    await waitingForMetadata.promise;
    queue.pushImmediate('from-queue', { permissionMode: 'default' });

    const result = await resultPromise;
    expect(result?.message).toBe('from-queue');
  });

  it('returns null when aborted while waiting for metadata updates', async () => {
    const queue = createQueue();
    const waitingForMetadata = createDeferred<void>();
    const popPendingMessage = vi.fn(async () => {
      throw new Error('retired boolean materialization must not be called');
    });
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));
    let waitCount = 0;

    const session: PermissionModeSessionFixture = {
      popPendingMessage,
      materializeNextPendingMessageSafely,
      async waitForMetadataUpdate(abortSignal?: AbortSignal) {
        waitCount += 1;
        waitingForMetadata.resolve();
        return await new Promise<boolean>((resolve) => {
          abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      },
    };

    const abortController = new AbortController();
    const resultPromise = waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: abortController.signal,
      session: asSessionClient(session),
    });

    await waitingForMetadata.promise;
    abortController.abort();

    await expect(resultPromise).resolves.toBeNull();
    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(popPendingMessage).not.toHaveBeenCalled();
    expect(waitCount).toBe(1);
  });

  it('waits for the next natural input while omitted quiet context remains retained', async () => {
    const queue = new MessageQueue2<QueueMode>(() => 'hash', {
      isContextOnly: text => text === 'quiet-original',
    });
    const waitingForMetadata = createDeferred<void>();
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));
    const session = asSessionClient({ materializeNextPendingMessageSafely,
      async waitForMetadataUpdate(signal?: AbortSignal) {
        waitingForMetadata.resolve();
        return await new Promise<boolean>(resolve => {
          if (signal?.aborted) resolve(false);
          else signal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      },
    });
    const abort = new AbortController();
    queue.push('quiet-original', { permissionMode: 'default' });
    queue.push('first-natural', { permissionMode: 'default' });
    const first = await waitForNextPermissionModeMessage({ messageQueue: queue, session, abortSignal: abort.signal });
    expect(first?.message).toBe('quiet-original\nfirst-natural');
    expect(queue.getContextOnlyMessages()).toEqual(['quiet-original']);

    let completed = false;
    const next = waitForNextPermissionModeMessage({ messageQueue: queue, session, abortSignal: abort.signal })
      .then(batch => { completed = true; return batch; });
    try {
      await waitingForMetadata.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(completed).toBe(false);
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledOnce();
      queue.push('second-natural', { permissionMode: 'default' });
      expect((await next)?.message).toBe('quiet-original\nsecond-natural');
      expect(queue.getContextOnlyMessages()).toEqual(['quiet-original']);
    } finally {
      abort.abort();
      await next;
    }
  });

  it('continues processing when onMetadataUpdate throws', async () => {
    const queue = createQueue();
    let pendingText: string | null = null;
    let metadataWaitCalls = 0;
    const popPendingMessage = vi.fn(async () => {
      throw new Error('retired boolean materialization must not be called');
    });
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      if (!pendingText) return { type: 'no_pending' as const };
      const text = pendingText;
      pendingText = null;
      queue.pushImmediate(text, { permissionMode: 'default' });
      return {
        type: 'materialized' as const,
        localId: 'pending-after-callback-error',
        seq: 1,
        content: null,
      };
    });

    const session: PermissionModeSessionFixture = {
      popPendingMessage,
      materializeNextPendingMessageSafely,
      async waitForMetadataUpdate(abortSignal?: AbortSignal) {
        metadataWaitCalls += 1;
        if (metadataWaitCalls === 1) return true;
        return await new Promise<boolean>((resolve) => {
          abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      },
    };

    const result = await waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: new AbortController().signal,
      session: asSessionClient(session),
      onMetadataUpdate: () => {
        pendingText = 'after-callback-error';
        throw new Error('expected test callback failure');
      },
    });

    expect(metadataWaitCalls).toBeGreaterThanOrEqual(1);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);
    expect(popPendingMessage).not.toHaveBeenCalled();
    expect(result?.message).toBe('after-callback-error');
  });
});
