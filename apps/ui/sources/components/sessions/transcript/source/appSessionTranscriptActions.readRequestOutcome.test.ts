import { beforeEach, describe, expect, it, vi } from 'vitest';

const scoped = vi.hoisted(() => ({
    capturedTargets: [] as unknown[],
    readSnapshot: vi.fn(),
    activeServerId: 'active-home',
}));

vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => async () => ({ ok: true }),
    requireActionSuccess: () => {},
}));
vi.mock('@/sync/http/client', () => ({ serverFetch: vi.fn() }));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: scoped.activeServerId }),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', () => ({
    runWithServerRequestAuthorityForServerAccountScope: async (target: unknown, operation: (authority: unknown) => Promise<unknown>) => {
        scoped.capturedTargets.push(target);
        return operation({ marker: 'authority' });
    },
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority', () => ({
    readSessionSnapshotForAuthority: scoped.readSnapshot,
}));

import { createAppSessionTranscriptActions } from './appSessionTranscriptActions';

function snapshotWith(agentState: unknown) {
    return { session: { id: 's1', agentState }, callerDataKeyEnvelope: null };
}

describe('createAppSessionTranscriptActions.readRequestOutcome', () => {
    beforeEach(() => {
        scoped.capturedTargets.length = 0;
        scoped.readSnapshot.mockReset();
    });

    it('reads the exact Session on its own Home and reports the exact request as pending', async () => {
        scoped.readSnapshot.mockResolvedValue(snapshotWith({ requests: { r1: { tool: 'Bash' } } }));
        const actions = createAppSessionTranscriptActions('s1', 'other-home');

        await expect(actions.readRequestOutcome!('r1')).resolves.toBe('pending');

        expect(scoped.capturedTargets).toEqual([expect.objectContaining({ serverId: 'other-home' })]);
        expect(scoped.readSnapshot).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
    });

    it('reports a completed request as settled', async () => {
        scoped.readSnapshot.mockResolvedValue(snapshotWith({ requests: { r2: {} }, completedRequests: { r1: { status: 'approved' } } }));
        await expect(createAppSessionTranscriptActions('s1', 'home').readRequestOutcome!('r1')).resolves.toBe('settled');
    });

    it.each([
        ['an unrelated request only', { requests: { other: {} } }],
        ['no agent state', null],
    ])('cannot tell for %s: the read rejects instead of guessing', async (_label, agentState) => {
        scoped.readSnapshot.mockResolvedValue(snapshotWith(agentState));
        await expect(createAppSessionTranscriptActions('s1', 'home').readRequestOutcome!('r1')).rejects.toThrow();
    });

    it('rejects when the scoped read fails and never falls back to a global refresh', async () => {
        scoped.readSnapshot.mockRejectedValue(new Error('offline'));
        await expect(createAppSessionTranscriptActions('s1', 'home').readRequestOutcome!('r1')).rejects.toThrow('offline');
    });

    it('targets the active Home only when the Actions themselves carry no Home', async () => {
        scoped.readSnapshot.mockResolvedValue(snapshotWith({ requests: { r1: {} } }));
        await createAppSessionTranscriptActions('s1', null).readRequestOutcome!('r1');
        expect(scoped.capturedTargets).toEqual([expect.objectContaining({ serverId: 'active-home' })]);
    });
});
