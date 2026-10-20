import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionGoalControlFailureV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';

const boundary = vi.hoisted(() => ({ session: vi.fn(), machine: vi.fn() }));
// RPC transports are system boundaries; target resolution, capability policy and storage remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({ sessionRpcWithServerScope: boundary.session }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.machine }));

const { storage } = await import('@/sync/domains/state/storage');
const { sessionGoalSet, sessionGoalClear, sessionGoalGet } = await import('./sessionGoals');
const original = storage.getState();

function installSession(active = false, supported = true) {
    const session = createSessionFixture({ active, serverId: 'goal-home', metadata: {
        path: '/repo', host: 'remote.test', machineId: 'goal-machine', flavor: 'codex', codexSessionId: 'native-thread',
    }, agentState: { capabilities: { sessionGoalSetSupported: supported, sessionGoalClearSupported: supported } } });
    const machine = createMachineFixture({ id: 'goal-machine', metadata: { ...createMachineFixture().metadata!, host: 'remote.test',
        daemonSessionGoalControlsSupported: supported } });
    storage.setState({ sessions: { [session.id]: session }, machines: { [machine.id]: machine } });
}

beforeEach(() => { boundary.session.mockReset(); boundary.machine.mockReset(); installSession(); });
afterEach(() => { storage.setState(original, true); });

describe('session goal controls', () => {
    it.each([false, true])('preserves closed Goal settlement evidence from the selected RPC (active: %s)', async active => {
        installSession(active);
        const failure = { ok: false, errorCode: 'session_goal_control_work_state_unavailable',
            error: 'session_goal_control_work_state_unavailable',
            goalControlFailure: SessionGoalControlFailureV1Schema.parse({ phase: 'missing_matching_publication' }) };
        boundary.session.mockResolvedValue(failure);
        boundary.machine.mockResolvedValue(failure);
        await expect(sessionGoalSet('session-1', { objective: 'Native task' })).resolves.toEqual(failure);
        await expect(sessionGoalGet('session-1')).resolves.toEqual(failure);
        await expect(sessionGoalClear('session-1')).resolves.toEqual(failure);
    });

    it('omits unvalidated Goal settlement evidence while preserving the RPC refusal', async () => {
        installSession(true);
        const failure = { ok: false, errorCode: 'session_goal_control_work_state_unavailable',
            error: 'session_goal_control_work_state_unavailable' };
        boundary.session.mockResolvedValue({ ...failure,
            goalControlFailure: { phase: 'missing_matching_publication', nativeError: 'private native details' } });
        await expect(sessionGoalSet('session-1', { objective: 'Native task' })).resolves.toEqual(failure);
    });

    it('uses the daemon for an active runtime without native goal controls', async () => {
        installSession(true);
        const session = storage.getState().sessions['session-1'];
        storage.setState({ sessions: { 'session-1': { ...session, agentState: null } } });
        boundary.machine.mockResolvedValue({ workState: null });
        const signal = new AbortController().signal;
        const options = { serverId: 'goal-home', signal };

        await expect(sessionGoalSet('session-1', { objective: 'Finish the task' }, options)).resolves.toEqual({ ok: true });
        await expect(sessionGoalGet('session-1', options)).resolves.toEqual({ workState: null });
        await expect(sessionGoalClear('session-1', options)).resolves.toEqual({ ok: true });
        expect(boundary.machine.mock.calls.map(call => call[0])).toEqual([
            { machineId: 'goal-machine', ...options, operationTimeoutMs: null, method: RPC_METHODS.DAEMON_SESSION_GOAL_SET_V2,
                payload: { sessionId: 'session-1', objective: 'Finish the task', resumeInactiveWithInitialGoal: true } },
            { machineId: 'goal-machine', ...options, operationTimeoutMs: null, method: RPC_METHODS.DAEMON_SESSION_GOAL_GET, payload: { sessionId: 'session-1' } },
            { machineId: 'goal-machine', ...options, operationTimeoutMs: null, method: RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR, payload: { sessionId: 'session-1' } },
        ]);
        expect(boundary.session).not.toHaveBeenCalled();
    });

    it('keeps partial native controls authoritative instead of silently giving the daemon the other mutation', async () => {
        installSession(true);
        const session = storage.getState().sessions['session-1'];
        storage.setState({ sessions: { 'session-1': { ...session, agentState: {
            capabilities: { sessionGoalSetSupported: true, sessionGoalClearSupported: false },
        } } } });
        boundary.session.mockResolvedValue({ workState: null });
        await expect(sessionGoalSet('session-1', { objective: 'Native task' })).resolves.toEqual({ ok: true });
        await expect(sessionGoalClear('session-1')).resolves.toMatchObject({ ok: false, errorCode: 'session_goal_control_unsupported' });
        expect(boundary.machine).not.toHaveBeenCalled();
    });

    it('sends inactive wake intent and budget to the exact daemon instead of starting another UI resume path', async () => {
        boundary.machine.mockResolvedValue({ workState: null });
        await expect(sessionGoalSet('session-1', { objective: 'Finish the task', tokenBudget: null }, { serverId: 'goal-home' }))
            .resolves.toEqual({ ok: true });
        expect(boundary.machine).toHaveBeenCalledWith({ machineId: 'goal-machine', serverId: 'goal-home', operationTimeoutMs: null,
            method: 'daemon.sessionGoal.set.v2', payload: { sessionId: 'session-1', objective: 'Finish the task',
                tokenBudget: null, resumeInactiveWithInitialGoal: true } });
        expect(boundary.session).not.toHaveBeenCalled();
    });

    it('keeps explicitly saved inactive objectives and other mutations on the legacy no-wake route', async () => {
        boundary.machine.mockResolvedValue({ workState: null });
        await expect(sessionGoalSet('session-1', { objective: 'Save for later', resumeInactiveWithInitialGoal: false }))
            .resolves.toEqual({ ok: true });
        expect(boundary.machine.mock.calls[0]?.[0]).toMatchObject({ method: RPC_METHODS.DAEMON_SESSION_GOAL_SET,
            payload: { sessionId: 'session-1', objective: 'Save for later' } });
        await expect(sessionGoalSet('session-1', { status: 'paused', tokenBudget: 5000 })).resolves.toEqual({ ok: true });
        await expect(sessionGoalClear('session-1')).resolves.toEqual({ ok: true });
        await expect(sessionGoalGet('session-1')).resolves.toEqual({ workState: null });
        expect(boundary.machine.mock.calls.map(call => call[0].method)).toEqual([
            RPC_METHODS.DAEMON_SESSION_GOAL_SET, RPC_METHODS.DAEMON_SESSION_GOAL_SET,
            RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR, RPC_METHODS.DAEMON_SESSION_GOAL_GET,
        ]);
    });

    it('refuses an older daemon wake operation without falling back to a no-wake success', async () => {
        boundary.machine.mockRejectedValue(Object.assign(new Error('RPC method not available'), { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' }));
        await expect(sessionGoalSet('session-1', { objective: 'Finish the task' })).resolves.toMatchObject({ ok: false });
        expect(boundary.machine).toHaveBeenCalledTimes(1);
        expect(boundary.session).not.toHaveBeenCalled();
    });

    it('uses the opened runtime controls and returns malformed or transient failures truthfully', async () => {
        installSession(true);
        const session = storage.getState().sessions['session-1'];
        storage.setState({ sessions: { 'session-1': { ...session, metadata: null } }, machines: {} });
        boundary.session.mockResolvedValueOnce({ workState: null }).mockResolvedValueOnce({ ok: 'invalid' })
            .mockRejectedValueOnce(new Error('transport failed'));
        await expect(sessionGoalSet('session-1', { objective: 'Finish the task' })).resolves.toEqual({ ok: true });
        expect(boundary.session.mock.calls[0]?.[0]).toMatchObject({ method: SESSION_RPC_METHODS.SESSION_GOAL_SET,
            payload: { objective: 'Finish the task' } });
        await expect(sessionGoalClear('session-1')).resolves.toMatchObject({ ok: false });
        await expect(sessionGoalSet('session-1', { status: 'paused' })).resolves.toMatchObject({ ok: false, error: 'transport failed' });
        expect(boundary.machine).not.toHaveBeenCalled();
    });

    it.each([false, true])('fails closed when the selected daemon does not advertise goal controls (active: %s)', async (active) => {
        installSession(active, false);
        await expect(sessionGoalSet('session-1', { objective: 'Finish the task' }))
            .resolves.toMatchObject({ ok: false, errorCode: 'session_goal_control_unsupported' });
        expect(boundary.machine).not.toHaveBeenCalled();
    });
});
