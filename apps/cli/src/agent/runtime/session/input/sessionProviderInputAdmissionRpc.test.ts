import { describe, expect, it, vi } from 'vitest';

import type { RpcHandler } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { readExecutionRunStartRunCreation } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from './sessionProviderInputConsumer';
import {
  registerSessionProviderInputAdmissionRpc,
  requestSessionProviderInputAdmission,
  createSessionRunnerRestartAdmission,
  prepareSessionRunnerRestartAdmission,
} from './sessionProviderInputAdmissionRpc';

describe('session provider-input admission RPC composition', () => {
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
