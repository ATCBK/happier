import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionSkillCatalogListResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';

const machineRpcMock = vi.hoisted(() => vi.fn(async (_params: unknown): Promise<unknown> => ({
    v: 1,
    skills: [],
})));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const state = {
        sessions: {
            session_1: {
                id: 'session_1',
                active: false,
                metadata: {
                    path: '/home/coder/project',
                    machineId: 'machine_1',
                },
            },
        },
        applySessions: vi.fn(),
    };
    return createStorageModuleStub({
        storage: { getState: () => state },
    });
});

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineControlTargetForSession: () => ({
        machineId: 'machine_1',
        basePath: '/Users/alice/project',
        agentBasePath: '/home/coder/project',
        confidence: 'reachable',
    }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => 'server_1',
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcMock(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => machineRpcMock(params),
}));

describe('ensureSessionSuggestionCatalogs', () => {
    beforeEach(() => {
        machineRpcMock.mockReset();
        machineRpcMock.mockResolvedValue({ v: 1, skills: [] });
    });

    it.each(['rejected', 'failure result', 'invalid response'] as const)(
        'publishes a typed cause for a %s and permits the next discovery to recover', async failure => {
            const { storage } = await import('@/sync/domains/state/storage');
            const { ensureSessionSuggestionCatalogs } = await import('./sessionCatalogs');
            const state = storage.getState();
            // Exercise the live-Session carrier as well as inactive Machine reads.
            state.sessions.session_1!.active = failure === 'rejected';
            const snapshots: unknown[] = [];
            const apply = vi.mocked(state.applySessions);
            apply.mockImplementation(sessions => {
                const snapshot = sessions[0];
                if (!snapshot) throw new Error('Expected Session catalog update');
                Object.assign(state.sessions.session_1!, snapshot);
                snapshots.push(snapshot.metadata?.sessionSkillCatalogV1);
            });
            Reflect.deleteProperty(state.sessions.session_1!.metadata!, 'sessionSkillCatalogV1');
            if (failure === 'rejected') machineRpcMock.mockRejectedValueOnce(createRpcCallError({ error: 'Transport failed', errorCode: 'RPC_TRANSPORT_UNAVAILABLE' }));
            else machineRpcMock.mockResolvedValueOnce(failure === 'failure result'
                ? { ok: false, errorCode: 'codex_catalog_request_failed', error: 'Native request failed' }
                : null);

            await ensureSessionSuggestionCatalogs('session_1', { skills: true });
            const diagnostic = failure === 'rejected' ? 'RPC_TRANSPORT_UNAVAILABLE'
                : failure === 'failure result' ? 'codex_catalog_request_failed' : 'invalid_session_skill_catalog_response';
            expect(snapshots[0]).toMatchObject({ skills: [], diagnostic });
            expect(SessionSkillCatalogListResponseV1Schema.parse(snapshots[0])).toMatchObject({ diagnostic });

            machineRpcMock.mockResolvedValueOnce({ skills: [{ v: 1, origin: 'vendor', backendId: 'codex', name: 'project-native' }] });
            await ensureSessionSuggestionCatalogs('session_1', { skills: true });
            expect(snapshots[1]).toMatchObject({ skills: [expect.objectContaining({ name: 'project-native' })] });
            expect(snapshots[1]).not.toHaveProperty('diagnostic');
            apply.mockReset();
            state.sessions.session_1!.active = false;
            Reflect.deleteProperty(state.sessions.session_1!.metadata!, 'sessionSkillCatalogV1');
        },
    );

    it('does not publish an error snapshot when discovery is canceled', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { ensureSessionSuggestionCatalogs } = await import('./sessionCatalogs');
        const controller = new AbortController();
        machineRpcMock.mockImplementationOnce(async () => {
            controller.abort();
            throw createRpcCallError({ error: 'Canceled', errorCode: 'RPC_TRANSPORT_UNAVAILABLE' });
        });
        await ensureSessionSuggestionCatalogs('session_1', { skills: true }, { signal: controller.signal });
        expect(storage.getState().applySessions).not.toHaveBeenCalled();
    });

    it('uses the machine workspace path for inactive-session catalogs', async () => {
        const { ensureSessionSuggestionCatalogs } = await import('./sessionCatalogs');

        await ensureSessionSuggestionCatalogs('session_1', { skills: true });

        expect(machineRpcMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: {
                sessionId: 'session_1',
                cwd: '/Users/alice/project',
            },
        }));
    });
});
