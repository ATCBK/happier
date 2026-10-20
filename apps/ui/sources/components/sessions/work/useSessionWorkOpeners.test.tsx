import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { renderHook, standardCleanup } from '@/dev/testkit';

const viewport = vi.hoisted(() => ({ width: 390, height: 844 }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ ...viewport, scale: 1, fontScale: 1 }),
    Dimensions: { get: () => ({ ...viewport, scale: 1, fontScale: 1 }) },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

import { useSessionWorkOpeners } from './useSessionWorkOpeners';
import type { WorkItem } from './workProjection';
import { isWorkflowRunPeekDetailsResource } from './createWorkflowRunPeekDetailsTab';

const report = {
    key: 'session:report', kind: 'session', title: 'Report', agentId: null,
    facts: [], parentKey: null, level: 0, progress: null,
    status: { bucket: 'idle', tone: 'neutral', word: 'Ready' },
    open: { kind: 'session', sessionId: 'report' },
} satisfies WorkItem;

const waitingRun = {
    ...report, key: 'workflow:run/7', kind: 'workflow_run', title: 'Review each changed file',
    status: { bucket: 'needs_you', tone: 'attention', word: 'Waiting for your review' },
    open: { kind: 'workflow_run', runId: 'run/7' },
} satisfies WorkItem;

function hostWith(push: ReturnType<typeof vi.fn>) {
    return function Wrapper({ children }: React.PropsWithChildren) {
        return <AppPaneProvider>
            <DestinationInstanceHost tabId="lead" ref={{ kind: 'session', params: { id: 'lead' } }} pathname="/session/lead" focused visible
                navigation={{ push, replace: () => {}, back: () => {} }}>
                {children}
            </DestinationInstanceHost>
        </AppPaneProvider>;
    };
}

describe('desktop Work navigation', () => {
    afterEach(() => {
        viewport.width = 390;
        viewport.height = 844;
        return standardCleanup();
    });

    it('peeks a workflow run beside the lead — even one waiting for the person — on the lead’s exact Home', async () => {
        viewport.width = 1440;
        viewport.height = 900;
        const push = vi.fn();
        const hook = await renderHook(() => ({
            openers: useSessionWorkOpeners({ sessionId: 'lead', serverId: 'lead-home', scopeId: 'session:lead', subagents: [] }),
            pane: useAppPaneScope('session:lead'),
        }), { wrapper: hostWith(push) });

        await act(async () => { hook.getCurrent().openers.openItem(waitingRun); });

        expect(push).not.toHaveBeenCalled();
        const tabs = hook.getCurrent().pane.scopeState?.details?.tabs ?? [];
        expect(tabs).toHaveLength(1);
        expect(tabs[0]?.title).toBe('Review each changed file');
        expect(isWorkflowRunPeekDetailsResource(tabs[0]?.resource)).toBe(true);
        expect(tabs[0]?.resource).toEqual({ kind: 'workflowRunPeek', runId: 'run/7', serverId: 'lead-home' });
    });
});

describe('phone Work navigation', () => {
    afterEach(standardCleanup);

    it('opens a report as a full Session while preserving the lead’s explicit Home', async () => {
        const push = vi.fn();
        function Wrapper({ children }: React.PropsWithChildren) {
            return <AppPaneProvider>
                <DestinationInstanceHost tabId="phone-lead" ref={{ kind: 'session', params: { id: 'lead' } }} pathname="/session/lead" focused visible
                    navigation={{ push, replace: () => {}, back: () => {} }}>
                    {children}
                </DestinationInstanceHost>
            </AppPaneProvider>;
        }
        const hook = await renderHook((serverId: string) => useSessionWorkOpeners({
            sessionId: 'lead', serverId, scopeId: 'session:lead', subagents: [],
        }), { wrapper: Wrapper, initialProps: 'report-home' });

        hook.getCurrent().openItem(report);

        expect(push).toHaveBeenCalledWith('/session/report?serverId=report-home');

        await hook.rerender('other-home');
        hook.getCurrent().openItem(report);
        expect(push).toHaveBeenLastCalledWith('/session/report?serverId=other-home');

        // A phone has no peek: the run, waiting for the person or not, is its own pushed page.
        hook.getCurrent().openItem(waitingRun);
        expect(push).toHaveBeenLastCalledWith('/workflows/runs/run%2F7?serverId=other-home');
    });
});
