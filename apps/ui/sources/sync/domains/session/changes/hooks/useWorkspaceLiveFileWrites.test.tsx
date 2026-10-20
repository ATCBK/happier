import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReducer } from '@happier-dev/session-core/reducer';
import type { Message, ToolCallMessage, ToolCall } from '@happier-dev/session-core/messages';
import { act, createSessionFixture, createMachineFixture, createToolCallMessageFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useSessionLiveFileWrites } from './useSessionLiveFileWrites';
import { useWorkspaceLiveFileWrites } from './useWorkspaceLiveFileWrites';
import { useWorkspaceFileWriteSettlements } from './useWorkspaceFileWriteSettlements';
import { useWorkspaceFileWriteTabPresentation } from '@/components/workspaces/files/useWorkspaceFileWriteTabPresentation';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'home-a', serverUrl: 'https://example.com', generation: 1 }),
}));

const scope = { serverId: 'home-a', machineId: 'machine-1', rootPath: '/repo' };
const original = storage.getState();
type SessionMessages = ReturnType<typeof storage.getState>['sessionMessages'][string];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function call(id: string, path: string, state: ToolCall['state'] = 'running'): ToolCallMessage {
    return createToolCallMessageFixture({ id, createdAt: 10, tool: {
        id, name: 'Write', input: { file_path: path, content: 'hello' }, state,
        createdAt: 10, startedAt: 12, completedAt: state === 'running' ? null : 15, description: null,
    } });
}

function transcript(messages: Message[], version = 1, isLoaded = true): SessionMessages {
    const messagesById = Object.fromEntries(messages.map(message => [message.id, message]));
    return { messageIdsOldestFirst: messages.map(message => message.id), messagesById, messagesMap: messagesById,
        reducerState: createReducer(), messagesVersion: version, isLoaded,
        latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null };
}

function session(id = 'session-1', overrides: Parameters<typeof createSessionFixture>[0] = {}) {
    return createSessionFixture({ id, serverId: 'home-a', active: true, activeAt: Date.now(),
        thinking: true, thinkingAt: Date.now(), latestTurnStatus: 'in_progress',
        metadata: { path: '/repo', host: 'test', machineId: 'machine-1' }, ...overrides });
}

beforeEach(() => {
    storage.setState({ sessions: { 'session-1': session() }, sessionMessages: {},
        machines: { 'machine-1': createMachineFixture({ id: 'machine-1', active: true }) },
        sessionListRowsByServerId: {}, sessionListIndexByServerId: {}, ordinarySessionListMembershipByServerId: {},
        getProjectForSession: () => null });
});
afterEach(async () => { await standardCleanup(); storage.setState(original); });

describe('live file-write hooks', () => {
    it('uses the shared tab status for a live file and retains non-file presentation', async () => {
        storage.setState({ sessionMessages: { 'session-1': transcript([call('tab-write', 'src/one.ts')]) } });
        const fallback = { faviconUrl: 'https://example.com/favicon.png', status: { tone: 'attention' as const, label: 'Needs input' } };
        const resolveFallback = () => fallback;
        const hook = await renderHook(() => useWorkspaceFileWriteTabPresentation(scope, resolveFallback));
        const resolve = hook.getCurrent();
        const file = { key: 'file:src/one.ts', kind: 'file', title: 'one.ts', resource: { kind: 'file', path: 'src/one.ts' }, isPinned: false, isPreview: true };
        expect(resolve(file)).toMatchObject({ faviconUrl: fallback.faviconUrl, status: { tone: 'working' } });
        expect(resolve({ ...file, kind: 'browser', resource: {} })).toBe(fallback);
        await act(async () => storage.setState({ sessionMessages: { 'session-1': transcript([call('tab-write', 'src/one.ts', 'completed')], 2) } }));
        expect(hook.getCurrent()(file)).toBe(fallback);
    });

    it('gates stuck running calls through canonical effective activity and keeps stable results on unrelated updates', async () => {
        storage.setState({ sessionMessages: { 'session-1': transcript([call('write-1', 'src/one.ts')]) } });
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useSessionLiveFileWrites({ serverId: 'home-a', sessionId: 'session-1' }, '/repo'); });
        const first = hook.getCurrent();
        expect([...first.keys()]).toEqual(['src/one.ts']);
        const initialRenders = renders;
        await act(async () => storage.setState({ isDataReady: !storage.getState().isDataReady }));
        expect(hook.getCurrent()).toBe(first);
        expect(renders).toBe(initialRenders);
        await act(async () => storage.setState(state => ({ sessions: { 'session-1': { ...state.sessions['session-1'], updatedAt: 99 } } })));
        expect(hook.getCurrent()).toBe(first);
        expect(renders).toBe(initialRenders);
        await act(async () => storage.setState({ sessions: { 'session-1': session('session-1', { thinking: false, latestTurnStatus: 'completed' }) } }));
        expect(hook.getCurrent().size).toBe(0);
        await act(async () => storage.setState({ sessions: { 'session-1': session('session-1', { presence: 'offline', active: false }) } }));
        expect(hook.getCurrent().size).toBe(0);
    });

    it('unions only attached sessions on the same Home and Machine and rejects same-id transcript leakage', async () => {
        storage.setState({ sessions: {
            one: session('one'), two: session('two'),
            wrongHome: session('wrongHome', { serverId: 'home-b' }),
            wrongRoot: session('wrongRoot', { metadata: { machineId: 'machine-1', path: '/elsewhere', host: 'test' } }),
        }, sessionMessages: {
            one: transcript([call('a', 'a.ts')]), two: transcript([call('b', 'b.ts')]),
            wrongHome: transcript([call('leak', 'leak.ts')]), wrongRoot: transcript([call('outside', 'outside.ts')]),
        } });
        const hook = await renderHook(() => useWorkspaceLiveFileWrites(scope));
        expect([...hook.getCurrent().keys()]).toEqual(['a.ts', 'b.ts']);
        const qualified = await renderHook(() => useSessionLiveFileWrites({ serverId: 'home-a', sessionId: 'wrongHome' }, '/repo'));
        expect(qualified.getCurrent().size).toBe(0);
    });

    it('infers the session workspace for absolute tool paths when no root override is supplied', async () => {
        storage.setState({ sessionMessages: { 'session-1': transcript([call('absolute', '/repo/src/one.ts')]) } });
        const hook = await renderHook(() => useSessionLiveFileWrites({ serverId: 'home-a', sessionId: 'session-1' }));
        expect([...hook.getCurrent().keys()]).toEqual(['src/one.ts']);
    });

    it('keeps a live background agent write after the primary turn completes', async () => {
        const task = createToolCallMessageFixture({ id: 'task', tool: { ...call('task', 'ignored.ts').tool, name: 'Task', input: {} },
            children: [call('background', 'background.ts')] });
        storage.setState({ sessions: { 'session-1': session('session-1', {
            thinking: false, latestTurnStatus: 'completed', runtimeActivityState: 'active', runtimeActivityActiveCount: 1,
        }) }, sessionMessages: { 'session-1': transcript([task]) } });
        const hook = await renderHook(() => useWorkspaceLiveFileWrites(scope));
        expect([...hook.getCurrent().keys()]).toEqual(['background.ts']);
    });
});

describe('useWorkspaceFileWriteSettlements', () => {
    it('seeds history, then settles running-to-completed and first-seen error once, even while idle', async () => {
        storage.setState({ sessionMessages: { 'session-1': transcript([call('history', 'old.ts', 'completed'), call('running', 'new.ts')]) } });
        const settled = vi.fn<(paths: readonly string[]) => void>();
        const hook = await renderHook(() => useWorkspaceFileWriteSettlements(scope, settled));
        expect(settled).not.toHaveBeenCalled();
        await act(async () => storage.setState({
            sessions: { 'session-1': session('session-1', { thinking: false, latestTurnStatus: 'completed' }) },
            sessionMessages: { 'session-1': transcript([call('history', 'old.ts', 'completed'), call('running', 'new.ts', 'completed'), call('batched', 'failed.ts', 'error')], 2) },
        }));
        expect(settled.mock.calls).toEqual([[['new.ts', 'failed.ts']]]);
        await hook.rerender();
        await act(async () => storage.setState({ sessionMessages: { 'session-1': transcript([call('running', 'new.ts', 'completed'), call('batched', 'failed.ts', 'error')], 3) } }));
        expect(settled.mock.calls).toEqual([[['new.ts', 'failed.ts']]]);
    });

    it('waits for the initial transcript load before seeding and resets when the workspace changes', async () => {
        const settled = vi.fn<(paths: readonly string[]) => void>();
        const hook = await renderHook(({ rootPath }) => useWorkspaceFileWriteSettlements({ ...scope, rootPath }, settled), { initialProps: { rootPath: '/repo' } });
        await act(async () => storage.setState({ sessionMessages: { 'session-1': transcript([call('loaded-history', 'old.ts', 'completed')]) } }));
        expect(settled).not.toHaveBeenCalled();
        await act(async () => storage.setState({ sessionMessages: { 'session-1': transcript([call('loaded-history', 'old.ts', 'completed'), call('new', 'new.ts', 'completed')], 2) } }));
        expect(settled.mock.calls).toEqual([[['new.ts']]]);
        await hook.rerender({ rootPath: '/other' });
        await act(async () => storage.setState({ sessions: { 'session-1': session('session-1', { metadata: { path: '/other', machineId: 'machine-1', host: 'test' } }) } }));
        expect(settled.mock.calls).toEqual([[['new.ts']]]);
    });

    it('settles a real normalized tool-call stream through the transcript reducer', async () => {
        storage.setState({ sessionMessages: { 'session-1': transcript([]) } });
        const settled = vi.fn<(paths: readonly string[]) => void>();
        const hook = await renderHook(() => {
            useWorkspaceFileWriteSettlements(scope, settled);
            return useWorkspaceLiveFileWrites(scope);
        });
        await act(async () => { storage.getState().applyMessages('session-1', [{
            id: 'provider-call', localId: null, createdAt: Date.now(), role: 'agent', isSidechain: false,
            content: [{ type: 'tool-call', id: 'write-stream', name: 'Write', input: { file_path: '/repo/src/created.ts', content: 'hello' },
                description: null, uuid: 'call-uuid', parentUUID: null }],
        }]); });
        expect([...hook.getCurrent().keys()]).toEqual(['src/created.ts']);
        expect(settled).not.toHaveBeenCalled();
        await act(async () => { storage.getState().applyMessages('session-1', [{
            id: 'provider-result', localId: null, createdAt: Date.now() + 1, role: 'agent', isSidechain: false,
            content: [{ type: 'tool-result', tool_use_id: 'write-stream', content: 'written', is_error: false,
                uuid: 'result-uuid', parentUUID: null }],
        }]); });
        expect(hook.getCurrent().size).toBe(0);
        expect(settled.mock.calls).toEqual([[['src/created.ts']]]);
    });
});
