import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { randomUUID } from 'node:crypto';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { z } from 'zod/mini';

import type { SessionProviderInputConsumer } from './_types';
import { registerSessionGuardNoticeRpc, type SessionGuardNoticeOwner } from './sessionGuardNoticeRpc';

const RUN_CREATION_METHODS = (['execution.run.start', 'execution.run.ensure', 'execution.run.ensure_or_start'] as const)
  .flatMap(id => {
    const { bindings } = getActionSpec(id);
    return [bindings?.rpcMethod, ...(bindings?.rpcMethodAliases ?? [])].filter((method): method is string => typeof method === 'string');
  });
const restartAdmissionRequestSchema = z.strictObject({
  action: z.enum(['restart_hold', 'restart_prepare']),
  requestId: z.string().check(z.minLength(1)),
  expectedPid: z.number().check(z.int(), z.positive()),
});
type RestartAdmissionRequest = z.infer<typeof restartAdmissionRequestSchema>;
const restartAdmissionResponseSchema = z.strictObject({
  status: z.enum(['ready', 'released', 'unavailable', 'unsupported']),
});

export class SessionRunnerRestartAdmissionUnsupportedError extends Error {
  constructor() { super('restart_admission_unsupported'); }
}

export type SessionRunnerRestartAdmissionRelease = (() => Promise<void>) & Readonly<{ signal: AbortSignal }>;

async function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}

async function waitForPreparation(ready: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { await Promise.race([ready, cancelled]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** The receiving RPC owner closes admission before draining; the daemon owns physical replacement. */
export function createSessionRunnerRestartAdmission(readRpc: () => RpcHandlerManager):
  (raw: unknown, signal?: AbortSignal) => Promise<z.infer<typeof restartAdmissionResponseSchema>> {
  let held: { requestId: string; attached: boolean; ready: Promise<void>; resolve: () => void; reject: (error: unknown) => void } | null = null;
  return async (raw: unknown, signal?: AbortSignal) => {
    const request = restartAdmissionRequestSchema.parse(raw);
    if (request.expectedPid !== process.pid || !signal || signal.aborted) return { status: 'unavailable' as const };
    if (held && held.requestId !== request.requestId) return { status: 'unavailable' as const };
    if (!held) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      void ready.catch(() => undefined);
      held = { requestId: request.requestId, attached: false, ready, resolve, reject };
    }
    const preparing = held;
    if (request.action === 'restart_prepare') {
      try {
        await waitForPreparation(preparing.ready, signal);
        return { status: held === preparing ? 'ready' as const : 'unavailable' as const };
      } finally {
        if (held === preparing && !preparing.attached) held = null;
      }
    }
    if (preparing.attached) return { status: 'unavailable' as const };
    preparing.attached = true;
    let release = () => {};
    try {
      const rpc = readRpc();
      release = rpc.pauseRequestAdmission(RUN_CREATION_METHODS, {
        details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
      });
      await rpc.waitForIdle(signal, RUN_CREATION_METHODS);
      signal.throwIfAborted();
      preparing.resolve();
      // This request remains in flight after readiness. Existing RPC cancellation
      // and transport retirement release its admission hold, even if no reply arrives.
      await untilAborted(signal);
      return { status: 'released' as const };
    } finally {
      preparing.reject(signal.reason ?? new Error('Restart preparation retired'));
      release();
      if (held === preparing) held = null;
    }
  };
}

/** Readiness observes the same still-live hold request; no remote release message is needed. */
export async function prepareSessionRunnerRestartAdmission(params: Readonly<{
  expectedPid: number;
  signal: AbortSignal;
  callRpc: (request: RestartAdmissionRequest, signal?: AbortSignal) => Promise<unknown>;
}>): Promise<SessionRunnerRestartAdmissionRelease | null> {
  const requestId = randomUUID();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([params.signal, lifetime.signal]);
  const request = { requestId, expectedPid: params.expectedPid };
  const parseResponse = (raw: unknown) => {
    const code = readRpcErrorCode(raw) ?? (raw && typeof raw === 'object' && 'errorCode' in raw ? raw.errorCode : undefined);
    if (code === RPC_ERROR_CODES.METHOD_NOT_FOUND || code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
      throw new SessionRunnerRestartAdmissionUnsupportedError();
    }
    const parsed = restartAdmissionResponseSchema.safeParse(raw);
    if (!parsed.success) {
      // A delivered response outside this private operation's contract is not
      // readiness. Pre-handshake receivers reject the action at their parser.
      if (code) throw new Error('Restart admission unavailable');
      throw new SessionRunnerRestartAdmissionUnsupportedError();
    }
    const response = parsed.data;
    if (response.status === 'unsupported') throw new SessionRunnerRestartAdmissionUnsupportedError();
    return response;
  };
  const hold = params.callRpc({ ...request, action: 'restart_hold' }, signal).then(parseResponse);
  // Losing the hold's observation also revokes readiness before the daemon signals.
  void hold.then(() => lifetime.abort(), () => lifetime.abort());
  const release = async () => {
    lifetime.abort();
    await hold.catch(() => undefined);
  };
  try {
    const result = await Promise.race([hold,
      params.callRpc({ ...request, action: 'restart_prepare' }, signal).then(parseResponse)]);
    if (result.status === 'ready' && !signal.aborted) return Object.assign(release, { signal });
  } catch (error) {
    await release();
    if (error instanceof SessionRunnerRestartAdmissionUnsupportedError) throw error;
    if (readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_FOUND || readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
      throw new SessionRunnerRestartAdmissionUnsupportedError();
    }
  }
  await release();
  return null;
}

export const SessionInputLiveWorkSchema = z.strictObject({
  session: z.enum(['active', 'settled', 'unknown']),
  input: z.enum(['active', 'settled', 'unknown']),
  agents: z.optional(z.enum(['active', 'settled', 'unknown'])),
  attention: z.optional(z.enum(['active', 'settled', 'unknown'])),
  agentsActiveCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  settledAt: z.optional(z.number().check(z.int(), z.nonnegative())),
});

const groupEnforceSchema = z.object({
  action: z.literal('enforce'),
  serviceId: z.string().check(z.trim(), z.minLength(1)),
  groupId: z.string().check(z.trim(), z.minLength(1)),
  reason: z.optional(z.enum(['group_unavailable', 'generation_pending'])),
  epochId: z.optional(z.string().check(z.trim(), z.minLength(1))),
});
const admissionRequestSchema = z.union([
  groupEnforceSchema,
  z.object({
    action: z.literal('clear'),
    serviceId: z.string().check(z.trim(), z.minLength(1)),
    groupId: z.string().check(z.trim(), z.minLength(1)),
    epochId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    applicationSettled: z.optional(z.literal(true)),
  }),
]).check(z.superRefine((request, ctx) => {
  if (
    request.action === 'enforce'
    && 'serviceId' in request
    && request.reason === 'generation_pending'
    && !request.epochId
  ) {
    ctx.addIssue({ code: "custom", message: 'generation_pending requires epochId' });
  }
}));

type AdmissionRequest = z.infer<typeof admissionRequestSchema>;

export function registerSessionProviderInputAdmissionRpc<Mode, Message>(params: Readonly<{
  consumer: SessionProviderInputConsumer<Mode, Message>;
  rpcHandlerRegistrar: RpcHandlerRegistrar;
  runnerRestartAdmission?: ReturnType<typeof createSessionRunnerRestartAdmission>;
  guardNotice?: SessionGuardNoticeOwner;
  onApplicationSettled?: (request: Readonly<{
    serviceId: string;
    groupId: string;
  }>) => Promise<void>;
}>): void {
  const guardNotice = params.guardNotice;
  if (guardNotice) registerSessionGuardNoticeRpc({
    get session() { return guardNotice.session; },
    machineId: guardNotice.machineId,
    agentId: guardNotice.agentId,
    notify: guardNotice.notify,
    rpcHandlerRegistrar: params.rpcHandlerRegistrar,
  });
  params.rpcHandlerRegistrar.registerHandler(
    SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION,
    async (raw: unknown, context) => {
      if (raw && typeof raw === 'object' && ('action' in raw)
        && (raw.action === 'restart_prepare' || raw.action === 'restart_hold')) {
        return params.runnerRestartAdmission ? await params.runnerRestartAdmission(raw, context?.signal)
          : { status: 'unsupported' as const };
      }
      const activityRead = z.strictObject({ action: z.literal('activity_read') }).safeParse(raw);
      if (activityRead.success) return SessionInputLiveWorkSchema.parse(await params.consumer.readLiveWork());
      const request = admissionRequestSchema.parse(raw);
      if (request.action === 'enforce') {
        const disposition = request.reason === 'generation_pending'
          ? {
              kind: 'action_required' as const,
              reason: 'generation_pending' as const,
              serviceId: request.serviceId,
              groupId: request.groupId,
              epochId: request.epochId!,
            }
          : {
              kind: 'action_required' as const,
              reason: 'group_unavailable' as const,
              serviceId: request.serviceId,
              groupId: request.groupId,
            };
        await params.consumer.enforceProviderInputAdmission(disposition);
        return { status: 'enforced' as const };
      }
      const result = await params.consumer.clearProviderInputAdmission(request);
      if (result.status === 'cleared' && request.applicationSettled === true) {
        await params.onApplicationSettled?.({
          serviceId: request.serviceId,
          groupId: request.groupId,
        }).catch(() => undefined);
      }
      return result;
    },
  );
}

/** Read-only projection from the live host; unavailable predecessors remain unknown at the caller. */
export async function requestSessionInputLiveWork(params: Readonly<{
  callRpc: (method: string, request: Readonly<{ action: 'activity_read' }>) => Promise<unknown>;
}>): Promise<z.infer<typeof SessionInputLiveWorkSchema>> {
  return SessionInputLiveWorkSchema.parse(await params.callRpc(
    SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, { action: 'activity_read' },
  ));
}

export async function requestSessionProviderInputAdmission(params: Readonly<{
  callRpc: (method: string, request: AdmissionRequest) => Promise<unknown>;
}> & AdmissionRequest): Promise<Readonly<{ status: 'enforced' | 'cleared' | 'not_matched' }>> {
  const request = admissionRequestSchema.parse(params);
  const raw = await params.callRpc(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, request);
  const result = z.object({ status: z.enum(['enforced', 'cleared', 'not_matched']) }).parse(raw);
  if (request.action === 'enforce' && result.status !== 'enforced') {
    throw new Error('provider_input_admission_not_enforced');
  }
  return result;
}
