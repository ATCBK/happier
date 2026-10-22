import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred, renderHook } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { useWorkBoard } from './useWorkBoards';

const requests: string[] = [];
let pendingList: Readonly<{ started: () => void; response: Promise<void> }> | null = null;
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
// Real Account, Artifact store, sync and Action owners run; only the Home HTTP boundary is observed.
const runtime = installSessionPaneRuntimeTestHarness({
    request: async (input, init) => {
        const url = new URL(String(input));
        requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (url.pathname === '/v1/artifacts' && pendingList) {
            const pending = pendingList;
            pendingList = null;
            pending.started();
            await pending.response;
        }
        return await artifacts.handle(`${url.pathname}${url.search}`, init);
    },
});

describe('Board body reads', () => {
    it('does not start Board bodies when the last view closes before its inventory returns', async () => {
        const executor = createDefaultActionExecutor();
        const created = await executor.execute('boards.apply', { intent: { kind: 'create', board: { id: 'closed-before-list', name: 'Closed Board' } } },
            { serverId: runtime.serverId, surface: 'ui', bypassApprovals: true });
        expect(created).toMatchObject({ ok: true });
        requests.length = 0;
        const started = createDeferred<void>();
        const response = createDeferred<void>();
        pendingList = { started: () => started.resolve(), response: response.promise };
        const hook = await renderHook(() => useWorkBoard('closed-before-list'), { wrapper: runtime.Wrapper });
        let mounted = true;
        try {
            await started.promise;
            await hook.unmount();
            mounted = false;
            await act(async () => { response.resolve(); });
            expect(requests.filter(request => request !== 'GET /v1/artifacts')).toEqual([]);
        } finally {
            pendingList = null;
            response.resolve();
            if (mounted) await hook.unmount();
        }
    });

    it('reads a mounted Board once and stays quiet while nothing changes', async () => {
        const executor = createDefaultActionExecutor();
        const context = { serverId: runtime.serverId, surface: 'ui', bypassApprovals: true } as const;
        const created = await executor.execute('boards.apply', { intent: { kind: 'create', board: { id: 'mine', name: 'My Board' } } }, context);
        expect(created, JSON.stringify(created) + ' ' + requests.join(' | ')).toMatchObject({ ok: true });
        requests.length = 0;

        const hook = await renderHook(() => useWorkBoard('mine'), { wrapper: runtime.Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent()?.id).toBe('mine'));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 1500)); });

        // The Board's audience is still read, but as part of that one read, not by reopening the Artifact.
        expect(requests.filter(request => /^GET \/v1\/artifacts\/mine$/.test(request)), requests.join(' | ')).toHaveLength(1);
        expect(requests.filter(request => request === 'GET /v1/artifacts/mine/access/grants')).toHaveLength(1);
    });
});
