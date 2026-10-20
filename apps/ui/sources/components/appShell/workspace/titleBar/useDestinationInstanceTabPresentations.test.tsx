import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } from '@/sync/domains/session/attention/runtimePresentation';
import { useDestinationInstanceTabPresentations } from './useDestinationInstanceTabPresentations';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const entries = [{ key: 'tab', ref: { kind: 'session', params: { id: 's1', serverId: 'home-a' } } }];
let previousState: ReturnType<typeof storage.getState>;
beforeEach(() => {
    previousState = storage.getState();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
});
afterEach(async () => {
    await standardCleanup();
    storage.setState(previousState, true);
    vi.useRealTimers();
});

function seed(overrides: Parameters<typeof createSessionListRenderableSessionFixture>[0] = {}) {
    const row = createSessionListRenderableSessionFixture({ id: 's1', active: true, activeAt: Date.now(), ...overrides });
    storage.setState({ sessionListRowsByServerId: { 'home-a': { s1: row } } });
    return row;
}

describe('workspace session tab presentation', () => {
    it('labels only an explicitly stopped offline process Stopped and follows its resume', async () => {
        const metadata = { path: '/repo', lifecycleState: 'stopped' };
        seed({ active: false, presence: undefined, metadata });
        const hook = await renderHook(() => useDestinationInstanceTabPresentations(entries));
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'offline', label: 'sessionWork.states.stopped' } });
        await act(async () => { seed({ active: false, presence: undefined, metadata: { ...metadata, lifecycleState: 'running' } }); });
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'offline', label: 'status.offline' } });
        await act(async () => { seed({ metadata: { ...metadata, lifecycleState: 'running' }, latestTurnStatus: 'in_progress' }); });
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'working', label: 'status.working' } });
    });

    it('follows the canonical live, attention, failure, offline and idle states', async () => {
        seed({ latestTurnStatus: 'in_progress' });
        const hook = await renderHook(() => useDestinationInstanceTabPresentations(entries));
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'working', label: 'status.working' } });
        await act(async () => { seed({ latestTurnStatus: 'in_progress', hasPendingPermissionRequests: true, pendingRequestObservedAt: Date.now() }); });
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'attention', label: 'status.permissionRequired' } });
        await act(async () => { seed({ latestTurnStatus: 'failed' }); });
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'failed' } });
        await act(async () => { seed({ latestTurnStatus: 'in_progress', presence: 999_000 }); });
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'offline', label: 'status.offline' } });
        await act(async () => { seed({ latestTurnStatus: 'in_progress', archivedAt: Date.now() }); });
        expect(hook.getCurrent().get('tab')).toBeUndefined();
        await act(async () => { seed(); });
        expect(hook.getCurrent().get('tab')).toBeUndefined();
    });

    it('uses the exact Home summary and ignores unrelated sessions and transcript updates', async () => {
        const row = seed({ latestTurnStatus: 'in_progress' });
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useDestinationInstanceTabPresentations(entries); });
        const before = hook.getCurrent();
        const rendersBefore = renders;
        await act(async () => {
            storage.setState({ sessionListRowsByServerId: { 'home-a': { s1: row }, 'home-b': { s1: createSessionListRenderableSessionFixture({ id: 's1', presence: 0 }) } } });
            storage.setState({ sessionMessages: {} });
        });
        expect(hook.getCurrent()).toBe(before);
        expect(renders).toBe(rendersBefore);
    });

    it('withdraws a working spinner at the canonical freshness deadline without a store update', async () => {
        seed({ latestTurnStatus: 'in_progress' });
        const hook = await renderHook(() => useDestinationInstanceTabPresentations(entries));
        expect(hook.getCurrent().get('tab')?.status?.tone).toBe('working');
        await act(async () => { await vi.advanceTimersByTimeAsync(SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 1); });
        expect(hook.getCurrent().get('tab')).toBeUndefined();
    });

    it('keeps resuming under the canonical owner until its marker clears', async () => {
        seed({ resumingAt: Date.now() });
        const hook = await renderHook(() => useDestinationInstanceTabPresentations(entries));
        expect(hook.getCurrent().get('tab')).toMatchObject({ status: { tone: 'working', label: 'session.resuming' } });
        await act(async () => { seed({ resumingAt: null }); });
        expect(hook.getCurrent().get('tab')).toBeUndefined();
    });

    it('keeps unreadable and uncached sessions quiet instead of guessing work or offline', async () => {
        seed({ latestTurnStatus: 'in_progress', encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_access_pending' });
        const hook = await renderHook(() => useDestinationInstanceTabPresentations(entries));
        expect(hook.getCurrent().get('tab')).toBeUndefined();
        await act(async () => { storage.setState({ sessionListRowsByServerId: {} }); });
        expect(hook.getCurrent().get('tab')).toBeUndefined();
    });
});
