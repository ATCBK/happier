import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { FollowListActionOutputV1Schema } from '@happier-dev/protocol/sessions/follow/actions';
import { parseSessionFollowActionResponse } from '@happier-dev/protocol/sessions/follow/actionTransport';
import type { SessionCoordinatorEnableInputV1 } from '@happier-dev/protocol/sessions/follow/sessionCoordinatorActionsV1';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getStorage } from '@/sync/domains/state/storageStore';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveSessionAddressFromLocalState } from '@/sync/domains/session/resolveSessionAddressFromLocalState';
import { createSessionCoordinatorRestoreInput, planSessionCoordinatorRuleRemoval, type SessionCoordinatorRemovedRule } from './sessionCoordinatorFollowControls';

let execute: ReturnType<typeof createFrontDoorActionExecute> | null = null;

type SessionScope = Readonly<{ serverId?: string | null }>;
export type SessionCoordinatorUndo = Readonly<{ address: SessionAddress | null; removed: readonly SessionCoordinatorRemovedRule[] }>;
export type SessionCoordinatorControlFailure = Readonly<{ ruleId: string; errorCode: string; result: ActionExecuteResult }>;
export type SessionCoordinatorStopResult = Readonly<{
    status: 'stopped' | 'partial' | 'unavailable'; coverage: 'complete' | 'partial' | 'unavailable';
    undo: SessionCoordinatorUndo; failures: readonly SessionCoordinatorControlFailure[];
    errorCode?: string; result?: ActionExecuteResult;
}>;
export type SessionCoordinatorRestoreResult = Readonly<{
    status: 'restored' | 'partial' | 'unavailable'; restoredRuleIds: readonly string[];
    failures: readonly SessionCoordinatorControlFailure[];
}>;

function addressFor(sessionId: string, scope?: SessionScope) {
    return scope?.serverId === undefined
        ? resolveSessionAddressFromLocalState(getStorage().getState(), sessionId)
        : normalizeSessionAddress(scope.serverId, sessionId);
}

async function dispatch(address: SessionAddress, actionId: 'follow.list' | 'follow.remove' | 'follow.set', input: unknown): Promise<ActionExecuteResult> {
    execute ??= createFrontDoorActionExecute();
    try { return await execute(actionId, input, { surface: 'ui', serverId: address.serverId }); }
    catch { return { ok: false, errorCode: 'action_execution_failed', error: 'Action execution failed' }; }
}

function failure(ruleId: string, result: ActionExecuteResult): SessionCoordinatorControlFailure {
    return { ruleId, result, errorCode: !result.ok ? result.errorCode
        : ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success ? 'approval_required' : 'invalid_response' };
}

export const sessionCoordinatorActions = {
    enable(sessionId: string, options: Omit<SessionCoordinatorEnableInputV1, 'sessionId'>, scope?: SessionScope): Promise<ActionExecuteResult> {
        const address = addressFor(sessionId, scope);
        if (!address) return Promise.resolve({ ok: false, errorCode: 'session_not_selected', error: 'Session Home is unavailable or ambiguous' });
        execute ??= createFrontDoorActionExecute();
        return execute('session.coordinator.enable', { ...options, sessionId: address.sessionId }, { surface: 'ui', serverId: address.serverId });
    },

    async stop(sessionId: string, scope?: SessionScope): Promise<SessionCoordinatorStopResult> {
        const address = addressFor(sessionId, scope);
        const removed: SessionCoordinatorRemovedRule[] = [];
        const failures: SessionCoordinatorControlFailure[] = [];
        const undo = { address, removed };
        if (!address) return { status: 'unavailable', coverage: 'unavailable', undo, failures, errorCode: 'session_not_selected' };
        const result = await dispatch(address, 'follow.list', { direction: 'following', receiver: { kind: 'session', sessionId: address.sessionId } });
        const snapshot = FollowListActionOutputV1Schema.safeParse(result.ok ? result.result : undefined);
        if (!snapshot.success) return { status: 'unavailable', coverage: 'unavailable', undo, failures,
            errorCode: failure('', result).errorCode, result };
        const plan = planSessionCoordinatorRuleRemoval(address, snapshot.data);
        if (plan.status === 'unavailable') return { status: 'unavailable', coverage: plan.coverage, undo, failures };
        for (const previous of plan.rules) {
            const input = { receiver: previous.receiver,
                source: { kind: 'rule' as const, ruleId: previous.ruleId }, expectedVersion: previous.version };
            const removal = await dispatch(address, 'follow.remove', input);
            try {
                const parsed = parseSessionFollowActionResponse('follow.remove', input, removal.ok ? removal.result : undefined);
                if (!('version' in parsed)) throw new Error('invalid_response');
                if (parsed.changed) removed.push({ previous, expectedVersion: parsed.version });
            } catch { failures.push(failure(previous.ruleId, removal)); }
        }
        return { status: failures.length ? 'partial' : 'stopped', coverage: 'complete', undo, failures };
    },

    async undoStop(undo: SessionCoordinatorUndo): Promise<SessionCoordinatorRestoreResult> {
        if (!undo.address) return { status: 'unavailable', restoredRuleIds: [], failures: [] };
        const restoredRuleIds: string[] = [];
        const failures: SessionCoordinatorControlFailure[] = [];
        for (const removed of undo.removed) {
            const input = createSessionCoordinatorRestoreInput(removed);
            const result = await dispatch(undo.address, 'follow.set', input);
            try {
                // The shared consumer checks identity, receiver, CAS and definition, not just the DTO shape.
                const restored = parseSessionFollowActionResponse('follow.set', input, result.ok ? result.result : undefined);
                if (!('rule' in restored)) throw new Error('invalid_response');
                restoredRuleIds.push(restored.rule.ruleId);
            } catch { failures.push(failure(removed.previous.ruleId, result)); }
        }
        return { status: failures.length ? 'partial' : 'restored', restoredRuleIds, failures };
    },
};
