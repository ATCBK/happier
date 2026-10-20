import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import type { ApprovalRequest } from '@happier-dev/protocol';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { storage } = await import('@/sync/domains/state/storage');
const {
    selectComposerApprovalRequestsForSurface,
    useComposerApprovalRequests,
    useFailedApprovalDismissal,
} = await import('./failedApprovalDismissal');
const initialState = storage.getState();

afterEach(() => {
    standardCleanup();
    storage.setState(initialState, true);
});

function request(artifactId: string, settled: 'open' | 'failed'): OpenApprovalArtifactForSession {
    const approval = settled === 'open'
        ? { v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent', sessionId: 's' },
            requestedSurface: 'agent', actionId: 'session.list', actionArgs: {}, summary: 'List sessions' }
        : { v: 1, status: 'executed', createdAtMs: 1, updatedAtMs: 2, createdBy: { surface: 'agent', sessionId: 's' },
            requestedSurface: 'agent', actionId: 'session.list', actionArgs: {}, summary: 'List sessions',
            decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: false, errorCode: 'boom', error: 'boom' } };
    return { artifact: { id: artifactId, header: { title: null } }, approval: approval as ApprovalRequest } as OpenApprovalArtifactForSession;
}

describe('failed approval dismissal', () => {
    it.each([
        { surface: 'composer', expectedComposerIds: ['open-1', 'failed-1'] },
        { surface: 'transcript', expectedComposerIds: ['failed-1'] },
    ] as const)('keeps mixed open and failed approvals on exactly one owned surface for $surface preference', ({ surface, expectedComposerIds }) => {
        const requests = [request('open-1', 'open'), request('failed-1', 'failed')];
        const composerIds = selectComposerApprovalRequestsForSurface(requests, surface).map(item => item.artifact.id);
        const transcriptIds = surface === 'transcript' ? ['open-1'] : [];

        expect(composerIds).toEqual(expectedComposerIds);
        expect([...composerIds, ...transcriptIds].sort()).toEqual(['failed-1', 'open-1']);
    });

    it('hides only the dismissed settled card from the composer and remembers it on this device', async () => {
        const requests = [request('open-1', 'open'), request('failed-1', 'failed'), request('failed-2', 'failed')];
        const hook = await renderHook(() => ({ shown: useComposerApprovalRequests(requests), dismissal: useFailedApprovalDismissal() }));
        expect(hook.getCurrent().shown.map(item => item.artifact.id)).toEqual(['open-1', 'failed-1', 'failed-2']);

        await act(async () => { hook.getCurrent().dismissal.dismiss('failed-1'); });
        expect(hook.getCurrent().shown.map(item => item.artifact.id)).toEqual(['open-1', 'failed-2']);
        expect(typeof storage.getState().localSettings.dismissedFailedApprovalsV1['failed-1']).toBe('number');
    });

    it('never hides an open approval, even one carrying a stale dismissal', async () => {
        await act(async () => { storage.getState().applyLocalSettings({ dismissedFailedApprovalsV1: { 'open-1': 1 } }); });
        const requests = [request('open-1', 'open')];
        const hook = await renderHook(() => useComposerApprovalRequests(requests));
        expect(hook.getCurrent().map(item => item.artifact.id)).toEqual(['open-1']);
    });
});
