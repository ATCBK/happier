import { SessionWorkStateGetResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import type { SessionGoalSetRequestV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { storage } from '@/sync/domains/state/storage';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { resolveSessionGoalExecutionCapabilities } from '@/sync/domains/session/control/sessionGoalExecutionCapabilities';
import { t } from '@/text';
import { readMachineControlTargetForSession } from './sessionMachineTarget';

export type SessionGoalMutationRequest = Readonly<{
    objective?: string;
    status?: SessionGoalSetRequestV1['status'];
    tokenBudget?: number | null;
    resumeInactiveWithInitialGoal?: boolean;
}>;

export type SessionGoalOperationResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: string; errorCode?: string }>;

type SessionGoalOptions = Readonly<{ serverId?: string | null; signal?: AbortSignal }>;

function goalError(errorCode: string): SessionGoalOperationResult {
    return { ok: false, error: errorCode, errorCode };
}

function readGoalOperationResult(response: unknown): SessionGoalOperationResult {
    if (response && typeof response === 'object') {
        const raw = response as Record<string, unknown>;
        if (raw.ok === true) return { ok: true };
        if (typeof raw.error === 'string') {
            return { ok: false, error: raw.error, ...(typeof raw.errorCode === 'string' ? { errorCode: raw.errorCode } : {}) };
        }
        if (SessionWorkStateGetResponseV1Schema.safeParse(raw).success) return { ok: true };
    }
    return { ok: false, error: t('session.workState.goal.errorUnsupportedResponse') };
}

function readGoalExecutionAvailability(sessionId: string) {
    const state = storage.getState();
    const session = state.sessions?.[sessionId];
    if (session?.active === true) {
        return { ...resolveSessionGoalExecutionCapabilities({ session }), machineAvailable: true };
    }
    const target = readMachineControlTargetForSession(sessionId);
    if (!target) return { canSet: false, canClear: false, machineAvailable: false };
    const machine = state.machines?.[target.machineId] ?? state.machineDisplayById?.[target.machineId] ?? null;
    return { ...resolveSessionGoalExecutionCapabilities({ session: session ?? { active: false }, machine }), machineAvailable: true };
}

async function runGoalRpc(sessionId: string, operation: 'get' | 'set' | 'clear', payload: Record<string, unknown>, opts?: SessionGoalOptions): Promise<unknown> {
    opts?.signal?.throwIfAborted();
    const serverId = opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId);
    if (storage.getState().sessions?.[sessionId]?.active === false) {
        const target = readMachineControlTargetForSession(sessionId);
        if (!target) return goalError('session_goal_control_machine_unavailable');
        return await machineRpcWithServerScope({ machineId: target.machineId, serverId,
            method: operation === 'get' ? RPC_METHODS.DAEMON_SESSION_GOAL_GET
                : operation === 'clear' ? RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR
                    : payload.resumeInactiveWithInitialGoal === true ? RPC_METHODS.DAEMON_SESSION_GOAL_SET_V2 : RPC_METHODS.DAEMON_SESSION_GOAL_SET,
            payload: { sessionId, ...payload }, ...(opts?.signal ? { signal: opts.signal } : {}) });
    }
    const { resumeInactiveWithInitialGoal: _wake, ...sessionPayload } = payload;
    return await sessionRpcWithServerScope({ sessionId, serverId,
        method: operation === 'get' ? SESSION_RPC_METHODS.SESSION_GOAL_GET
            : operation === 'clear' ? SESSION_RPC_METHODS.SESSION_GOAL_CLEAR : SESSION_RPC_METHODS.SESSION_GOAL_SET,
        payload: sessionPayload, ...(opts?.signal ? { signal: opts.signal } : {}) });
}

function transportError(error: unknown): SessionGoalOperationResult {
    const errorCode = readRpcErrorCode(error);
    return { ok: false, error: error instanceof Error ? error.message : t('session.workState.goal.errorUnknown'),
        ...(errorCode ? { errorCode } : {}) };
}

export async function sessionGoalGet(sessionId: string, opts?: SessionGoalOptions): Promise<unknown> {
    try {
        const result = await runGoalRpc(sessionId, 'get', {}, opts);
        return SessionWorkStateGetResponseV1Schema.safeParse(result).success ? result : readGoalOperationResult(result);
    } catch (error) { return transportError(error); }
}

export async function sessionGoalSet(sessionId: string, request: SessionGoalMutationRequest, opts?: SessionGoalOptions): Promise<SessionGoalOperationResult> {
    const availability = readGoalExecutionAvailability(sessionId);
    if (!availability.machineAvailable) return goalError('session_goal_control_machine_unavailable');
    if (!availability.canSet) return goalError('session_goal_control_unsupported');
    const wake = typeof request.objective === 'string' && request.objective.trim().length > 0 && request.resumeInactiveWithInitialGoal !== false;
    const payload = {
        ...(typeof request.objective === 'string' ? { objective: request.objective } : {}),
        ...(request.status ? { status: request.status } : {}),
        ...('tokenBudget' in request ? { tokenBudget: request.tokenBudget } : {}),
        ...(wake ? { resumeInactiveWithInitialGoal: true } : {}),
    };
    try { return readGoalOperationResult(await runGoalRpc(sessionId, 'set', payload, opts)); }
    catch (error) { return transportError(error); }
}

export async function sessionGoalClear(sessionId: string, opts?: SessionGoalOptions): Promise<SessionGoalOperationResult> {
    const availability = readGoalExecutionAvailability(sessionId);
    if (!availability.machineAvailable) return goalError('session_goal_control_machine_unavailable');
    if (!availability.canClear) return goalError('session_goal_control_unsupported');
    try { return readGoalOperationResult(await runGoalRpc(sessionId, 'clear', {}, opts)); }
    catch (error) { return transportError(error); }
}
