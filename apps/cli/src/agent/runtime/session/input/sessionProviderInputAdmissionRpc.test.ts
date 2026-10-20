import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'socket.io-client';

import type { RpcHandler } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { readExecutionRunStartRunCreation } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { readSessionRunnerRestartAdmissionCurrent } from '@/daemon/plannedRunnerRestart/sessionRunnerRestartAdmission';
import { createSessionProviderInputConsumer } from './sessionProviderInputConsumer';
import {
  registerSessionProviderInputAdmissionRpc,
  requestSessionProviderInputAdmission,
  createSessionRunnerRestartAdmission,
  prepareSessionRunnerRestartAdmission,
} from './sessionProviderInputAdmissionRpc';

describe('session provider-input admission RPC composition', () => {
  it.each(['local cancel', 'relayed cancel', 'target disconnect'] as const)(
    'settles creation with noRunCreated on %s during a stalled daemon read', async kind => {
      let readEntered!: () => void;
      const entered = new Promise<void>(resolve => { readEntered = resolve; });
      let respond = () => {};
      const server = createServer((_request, reply) => {
        respond = () => {
          if (reply.destroyed || reply.writableEnded) return;
          reply.writeHead(200, { 'content-type': 'application/json' });
          reply.end(JSON.stringify({ current: false }));
        };
        readEntered();
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const target = { pid: process.pid, httpPort: (server.address() as AddressInfo).port, controlToken: 'fixture-token' };
      const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger: () => {} });
      const listeners = new Map<string, (payload: unknown) => void>();
      // Boundary: the receiving Socket.IO connection and its cancellation event.
      rpc.onSocketConnect({ auth: {}, emit() {}, on(event: string, listener: (payload: unknown) => void) {
        listeners.set(event, listener);
      } } as unknown as Socket);
      const handler = vi.fn(async () => ({ admitted: true }));
      rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, handler);
      let observationSignal: AbortSignal | undefined;
      const admission = createSessionRunnerRestartAdmission(() => rpc, {
        readHoldCurrent: (request, signal) => {
          observationSignal = signal;
          return readSessionRunnerRestartAdmissionCurrent(request, { target, signal });
        },
      });
      const holdOwner = new AbortController();
      const request = { requestId: 'held-attempt', expectedPid: process.pid };
      rpc.registerHandler(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION,
        (input, context) => admission(input, context?.signal));
      const held = kind === 'target disconnect'
        ? rpc.handleRequest({ method: `session:${SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION}`,
          params: { ...request, action: 'restart_hold' }, requestId: 'transported-hold' })
        : admission({ ...request, action: 'restart_hold' }, holdOwner.signal);
      let creation: Promise<unknown> | undefined;
      try {
        await admission({ ...request, action: 'restart_prepare' }, holdOwner.signal);
        const caller = new AbortController();
        let settled = false;
        creation = (kind === 'local cancel'
          ? rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {}, { signal: caller.signal })
          : rpc.handleRequest({ method: `session:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`,
            params: {}, requestId: 'waiting-creation' }))
          .then(value => { settled = true; return value; });
        await entered;
        if (kind === 'local cancel') caller.abort();
        else if (kind === 'relayed cancel') listeners.get('rpc-cancel')?.({ requestId: 'waiting-creation' });
        else rpc.onSocketDisconnect();
        // Cross two event-loop turns, without answering the stalled HTTP request.
        await new Promise<void>(resolve => setImmediate(resolve));
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(settled).toBe(true);
        const result = await creation as { details?: unknown };
        expect(readExecutionRunStartRunCreation(result.details)).toBe('noRunCreated');
        expect(observationSignal?.aborted).toBe(true);
        expect(handler).not.toHaveBeenCalled();
        // Retiring a creation must not retire the independently live restart hold.
        expect(holdOwner.signal.aborted).toBe(false);
        holdOwner.abort();
        await held;
        await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toEqual({ admitted: true });
      } finally {
        respond();
        holdOwner.abort();
        rpc.onSocketDisconnect();
        await held;
        await creation;
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    },
  );

  it('uses the transported creation deadline while awaiting daemon currentness', async () => {
    vi.useFakeTimers();
    const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger: () => {} });
    const handler = vi.fn(async () => ({ admitted: true }));
    rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, handler);
    let finishRead!: (current: boolean) => void;
    let readEntered!: () => void;
    const entered = new Promise<void>(resolve => { readEntered = resolve; });
    const read = new Promise<boolean>(resolve => { finishRead = resolve; });
    const admission = createSessionRunnerRestartAdmission(() => rpc, {
      readHoldCurrent: () => { readEntered(); return read; },
    });
    const holdOwner = new AbortController();
    const request = { requestId: 'deadline-attempt', expectedPid: process.pid };
    const held = admission({ ...request, action: 'restart_hold' }, holdOwner.signal);
    let creation: Promise<unknown> | undefined;
    try {
      await admission({ ...request, action: 'restart_prepare' }, holdOwner.signal);
      let settled = false;
      creation = rpc.handleRequest({ method: `session:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`,
        params: {}, requestId: 'deadline-creation', timeoutMs: 60_000 })
        .then(result => { settled = true; return result; });
      await entered;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(true);
      const result = await creation as { details?: unknown };
      expect(readExecutionRunStartRunCreation(result.details)).toBe('noRunCreated');
      expect(handler).not.toHaveBeenCalled();
    } finally {
      finishRead(false);
      holdOwner.abort();
      await held;
      await creation;
      vi.useRealTimers();
    }
  });

  it('keeps concurrent creation lifetimes independent and dispatches with the original live signal', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger: () => {} });
    const signals: AbortSignal[] = [];
    rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, async (_input, context) => {
      signals.push(context!.signal);
      return { admitted: true };
    });
    const reads: { signal: AbortSignal; resolve: (current: boolean) => void }[] = [];
    const admission = createSessionRunnerRestartAdmission(() => rpc, {
      // Boundary: independent currentness requests to the daemon.
      readHoldCurrent: (_request, signal) => new Promise<boolean>(resolve => { reads.push({ signal, resolve }); }),
    });
    const holdOwner = new AbortController();
    const request = { requestId: 'concurrent-attempt', expectedPid: process.pid };
    const held = admission({ ...request, action: 'restart_hold' }, holdOwner.signal);
    const cancelled = new AbortController();
    const live = new AbortController();
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    try {
      await admission({ ...request, action: 'restart_prepare' }, holdOwner.signal);
      first = rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {}, { signal: cancelled.signal });
      second = rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {}, { signal: live.signal });
      expect(reads).toHaveLength(2);
      cancelled.abort();
      const refused = await first as { details?: unknown };
      expect(readExecutionRunStartRunCreation(refused.details)).toBe('noRunCreated');
      expect(reads[0].signal.aborted).toBe(true);
      expect(reads[1].signal.aborted).toBe(false);
      reads[1].resolve(false);
      await expect(second).resolves.toEqual({ admitted: true });
      expect(signals).toEqual([live.signal]);
    } finally {
      for (const read of reads) read.resolve(false);
      holdOwner.abort();
      await held;
      await first;
      await second;
    }
  });

  it('does not let a retired creation read release a newer hold', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger: () => {} });
    rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, async () => ({ admitted: true }));
    let finishRead!: (value: boolean) => void;
    const read = new Promise<boolean>(resolve => { finishRead = resolve; });
    const admission = createSessionRunnerRestartAdmission(() => rpc, {
      readHoldCurrent: request => request.requestId === 'first' ? read : Promise.resolve(true),
    });
    const firstOwner = new AbortController();
    const secondOwner = new AbortController();
    const firstRequest = { requestId: 'first', expectedPid: process.pid };
    const secondRequest = { requestId: 'second', expectedPid: process.pid };
    const firstHold = admission({ ...firstRequest, action: 'restart_hold' }, firstOwner.signal);
    let secondHold: Promise<unknown> | undefined;
    let creation: Promise<unknown> | undefined;
    try {
      await admission({ ...firstRequest, action: 'restart_prepare' }, firstOwner.signal);
      creation = rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {});
      firstOwner.abort();
      await firstHold;
      secondHold = admission({ ...secondRequest, action: 'restart_hold' }, secondOwner.signal);
      await admission({ ...secondRequest, action: 'restart_prepare' }, secondOwner.signal);
      finishRead(false);
      const refused = await creation as { details?: unknown };
      expect(readExecutionRunStartRunCreation(refused.details)).toBe('noRunCreated');
      const stillClosed = await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {}) as { details?: unknown };
      expect(readExecutionRunStartRunCreation(stillClosed.details)).toBe('noRunCreated');
    } finally {
      finishRead(false);
      firstOwner.abort();
      secondOwner.abort();
      await firstHold;
      await secondHold;
      await creation;
    }
  });

  it('checks the daemon once on closed-gate demand and releases only a definitely retired attempt', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger: () => {} });
    rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, async () => ({ admitted: true }));
    // Boundary: the local daemon HTTP currentness read, including an unreadable response.
    let current: boolean | null = true;
    const readHoldCurrent = vi.fn(async () => current);
    const admission = createSessionRunnerRestartAdmission(() => rpc, { readHoldCurrent });
    const receiver = new AbortController();
    const request = { requestId: 'lost-forward-attempt', expectedPid: process.pid };
    const held = admission({ ...request, action: 'restart_hold' }, receiver.signal);
    try {
      await expect(admission({ ...request, action: 'restart_prepare' }, receiver.signal)).resolves.toEqual({ status: 'ready' });
      expect(readHoldCurrent).not.toHaveBeenCalled();
      await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE });
      current = null;
      await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE });
      current = false;
      await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toEqual({ admitted: true });
      await expect(held).resolves.toEqual({ status: 'released' });
    } finally { receiver.abort(); await held; }
  });
  it('keeps a ready hold in the request lifetime when remote release is lost', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger: () => {} });
    rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, async () => ({ admitted: true }));
    const admission = createSessionRunnerRestartAdmission(() => rpc);
    const lifetime = new AbortController();
    const release = await prepareSessionRunnerRestartAdmission({ expectedPid: process.pid, signal: lifetime.signal,
      callRpc: (request, signal) => {
        if (String(request.action) === 'restart_release') throw new Error('Lost release');
        return admission(request, signal);
      } });
    expect(release).not.toBeNull();
    lifetime.abort();
    const releasing = release?.();
    void releasing?.catch(() => undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toEqual({ admitted: true });
    await releasing;
  });
  it('refuses the provider-safe creation alias with definite no-Run evidence', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger: () => {} });
    const method = SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1;
    const handler = vi.fn(async () => ({ admitted: true }));
    rpc.registerHandler(method, handler);
    const admission = createSessionRunnerRestartAdmission(() => rpc);
    const release = await prepareSessionRunnerRestartAdmission({ expectedPid: process.pid, signal: new AbortController().signal,
      callRpc: (request, signal) => admission(request, signal) });
    try {
      const result = await rpc.invokeLocal(method, {}) as { details?: unknown };
      expect(handler).not.toHaveBeenCalled();
      expect(readExecutionRunStartRunCreation(result.details)).toBe('noRunCreated');
    } finally { await release?.(); }
  });
  it('reopens a ready transported hold on receiver disconnect', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger: () => {} });
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2(() => 'fixture'),
      session: { waitForMetadataUpdate: () => new Promise<boolean>(() => {}) } });
    registerSessionProviderInputAdmissionRpc({ consumer, rpcHandlerRegistrar: rpc,
      runnerRestartAdmission: createSessionRunnerRestartAdmission(() => rpc) });
    rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, async () => ({ admitted: true }));
    const release = await prepareSessionRunnerRestartAdmission({ expectedPid: process.pid, signal: new AbortController().signal,
      callRpc: request => rpc.handleRequest({ method: `session:${SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION}`, params: request }) });
    expect(release).not.toBeNull();
    rpc.onSocketDisconnect();
    await release?.();
    await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toEqual({ admitted: true });
  });
  it('pairs reordered readiness with its live hold and keeps an older cancellation out of the next attempt', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger: () => {} });
    rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, async () => ({ admitted: true }));
    const admission = createSessionRunnerRestartAdmission(() => rpc);
    const first = new AbortController();
    const request = { requestId: 'first', expectedPid: process.pid };
    const ready = admission({ ...request, action: 'restart_prepare' }, first.signal);
    const held = admission({ ...request, action: 'restart_hold' }, first.signal);
    await expect(ready).resolves.toEqual({ status: 'ready' });
    first.abort();
    await held;
    const next = await prepareSessionRunnerRestartAdmission({ expectedPid: process.pid, signal: new AbortController().signal,
      callRpc: (request, signal) => admission(request, signal) });
    try {
      await expect(admission({ ...request, action: 'restart_prepare' }, new AbortController().signal)).resolves.toEqual({ status: 'unavailable' });
      await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE });
    } finally { await next?.(); }
    await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toEqual({ admitted: true });
  });
  it('keeps attempts and receiving process identity separate through cancellation', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger: () => {} });
    rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, async () => ({ admitted: true }));
    const admission = createSessionRunnerRestartAdmission(() => rpc);
    const request = { requestId: 'current-attempt', expectedPid: process.pid };
    const lifetime = new AbortController();
    await expect(admission({ ...request, expectedPid: process.pid + 1, action: 'restart_hold' }, lifetime.signal)).resolves.toEqual({ status: 'unavailable' });
    const hold = admission({ ...request, action: 'restart_hold' }, lifetime.signal);
    await expect(admission({ ...request, action: 'restart_prepare' }, lifetime.signal)).resolves.toEqual({ status: 'ready' });
    await expect(admission({ ...request, requestId: 'old-attempt', action: 'restart_prepare' }, lifetime.signal)).resolves.toEqual({ status: 'unavailable' });
    await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE });
    lifetime.abort();
    await expect(hold).resolves.toEqual({ status: 'released' });
    await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toEqual({ admitted: true });
  });
  it.each([SESSION_RPC_METHODS.EXECUTION_RUN_START, SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
    SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START, SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1])('drains %s and protects the signal interval without waiting for readers', async method => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger: () => {} });
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2(() => 'fixture'),
      session: { waitForMetadataUpdate: () => new Promise<boolean>(() => {}) } });
    registerSessionProviderInputAdmissionRpc({ consumer, rpcHandlerRegistrar: rpc,
      runnerRestartAdmission: createSessionRunnerRestartAdmission(() => rpc) });
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    let finishReader!: () => void;
    const heldReader = new Promise<void>(resolve => { finishReader = resolve; });
    rpc.registerHandler(method, async () => { await held; return { admitted: true }; });
    rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_GET, async () => heldReader);
    const creation = rpc.invokeLocal(method, {});
    const reader = rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_GET, {});
    const lifetime = new AbortController();
    const preparing = prepareSessionRunnerRestartAdmission({ expectedPid: process.pid, signal: lifetime.signal,
      callRpc: (request, signal) => rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, request, { signal }) });
    let release: (() => Promise<void>) | null = null;
    try {
      await expect(rpc.invokeLocal(method, {})).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE });
      finish();
      await creation;
      release = await preparing;
      expect(release).not.toBeNull();
      expect(rpc.getInFlightRequestCount()).toBe(2); // reader and the live restart request
      await expect(rpc.invokeLocal(method, {})).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE });
      await release?.();
      await expect(rpc.invokeLocal(method, {})).resolves.toEqual({ admitted: true });
    } finally { finish(); finishReader(); await creation; await reader; await release?.(); }
  });

  it('reopens creation admission when the restart wait is cancelled without cancelling the held Start', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'session', encryptionMode: 'plain', logger: () => {} });
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2(() => 'fixture'),
      session: { waitForMetadataUpdate: () => new Promise<boolean>(() => {}) } });
    registerSessionProviderInputAdmissionRpc({ consumer, rpcHandlerRegistrar: rpc,
      runnerRestartAdmission: createSessionRunnerRestartAdmission(() => rpc) });
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, async () => { await held; return { admitted: true }; });
    const creation = rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {});
    const lifetime = new AbortController();
    const preparing = prepareSessionRunnerRestartAdmission({ expectedPid: process.pid, signal: lifetime.signal,
      callRpc: (request, signal) => rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, request, { signal }) });
    lifetime.abort(new Error('Restart observation retired'));
    try {
      await expect(preparing).resolves.toBeNull();
      expect(rpc.getInFlightRequestCount()).toBe(1);
      finish();
      await expect(creation).resolves.toEqual({ admitted: true });
      await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toEqual({ admitted: true });
    } finally { finish(); await creation; }
  });
  it('uses the persistent gate and exact-epoch compare-and-set', async () => {
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<{ id: string }, string>(() => 'hash'),
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    const handlers = new Map<string, RpcHandler>();
    registerSessionProviderInputAdmissionRpc({
      consumer,
      rpcHandlerRegistrar: { registerHandler: (method, handler) => handlers.set(method, handler) },
    });
    const callRpc = async (method: string, request: unknown) => {
      const handler = handlers.get(method);
      if (!handler) throw new Error('missing handler');
      return await handler(request);
    };

    await requestSessionProviderInputAdmission({
      callRpc,
      action: 'enforce',
      reason: 'generation_pending',
      serviceId: 'openai-codex',
      groupId: 'primary',
      epochId: 'revision-1',
    });
    await requestSessionProviderInputAdmission({
      callRpc,
      action: 'enforce',
      reason: 'generation_pending',
      serviceId: 'openai-codex',
      groupId: 'primary',
      epochId: 'revision-2',
    });

    await expect(requestSessionProviderInputAdmission({
      callRpc,
      action: 'clear',
      serviceId: 'openai-codex',
      groupId: 'primary',
      epochId: 'revision-1',
    })).resolves.toEqual({ status: 'not_matched' });
    expect(consumer.readProviderInputAdmission()).toMatchObject({ epochId: 'revision-2' });
  });

  it('clears a preexisting unavailable block after exact generation adoption clears', async () => {
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<{ id: string }, string>(() => 'hash'),
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    await consumer.enforceProviderInputAdmission({
      kind: 'action_required',
      reason: 'group_unavailable',
      serviceId: 'openai-codex',
      groupId: 'primary',
    });
    await consumer.enforceProviderInputAdmission({
      kind: 'action_required',
      reason: 'generation_pending',
      serviceId: 'openai-codex',
      groupId: 'primary',
      epochId: 'revision-2',
    });

    await expect(consumer.clearProviderInputAdmission({
      serviceId: 'openai-codex', groupId: 'primary', epochId: 'revision-2',
    })).resolves.toEqual({ status: 'cleared' });
    expect(consumer.readProviderInputAdmission()).toMatchObject({ reason: 'group_unavailable' });
    await expect(consumer.clearProviderInputAdmission({
      serviceId: 'openai-codex', groupId: 'primary',
    })).resolves.toEqual({ status: 'cleared' });
    expect(consumer.readProviderInputAdmission()).toEqual({ kind: 'admitted' });
  });

  it('notifies the provider runtime after exact application without making notification part of admission settlement', async () => {
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<{ id: string }, string>(() => 'hash'),
      session: {
        waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      },
    });
    await consumer.enforceProviderInputAdmission({
      kind: 'action_required',
      reason: 'generation_pending',
      serviceId: 'claude-subscription',
      groupId: 'primary',
      epochId: 'revision-2',
    });
    const handlers = new Map<string, RpcHandler>();
    const onApplicationSettled = vi.fn(async () => {
      throw new Error('provider_surface_cleanup_failed');
    });
    registerSessionProviderInputAdmissionRpc({
      consumer,
      onApplicationSettled,
      rpcHandlerRegistrar: { registerHandler: (method, handler) => handlers.set(method, handler) },
    });
    const callRpc = async (method: string, request: unknown) => {
      const handler = handlers.get(method);
      if (!handler) throw new Error('missing handler');
      return await handler(request);
    };

    await expect(requestSessionProviderInputAdmission({
      callRpc,
      action: 'clear',
      serviceId: 'claude-subscription',
      groupId: 'primary',
      epochId: 'revision-2',
      applicationSettled: true,
    })).resolves.toEqual({ status: 'cleared' });
    expect(onApplicationSettled).toHaveBeenCalledOnce();
    expect(consumer.readProviderInputAdmission()).toEqual({ kind: 'admitted' });

    await expect(requestSessionProviderInputAdmission({
      callRpc,
      action: 'clear',
      serviceId: 'claude-subscription',
      groupId: 'primary',
      epochId: 'revision-stale',
      applicationSettled: true,
    })).resolves.toEqual({ status: 'not_matched' });
    expect(onApplicationSettled).toHaveBeenCalledOnce();
  });
});
