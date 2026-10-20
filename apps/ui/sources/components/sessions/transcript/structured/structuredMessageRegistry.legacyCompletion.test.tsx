import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const routerSpies = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerSpies.push } }).module;
});

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { renderStructuredMessage } = await import('./StructuredMessageBlock');
const { AppSessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/appSessionTranscriptSource');

describe('legacy execution completion transcript reader', () => {
    // Vector from ../0.2 @17ba05df68 structuredMessages/executionRunCompletionV1.ts.
    it.each([true, false])('renders the retained 0.2 input with inspect authority (public=%s)', async (isPublic) => {
        routerSpies.push.mockReset();
        const element = renderStructuredMessage({
            sessionId: 'lead',
            serverId: 'home-b',
            interaction: isPublic ? deriveTranscriptInteraction({ kind: 'public' }) : { canSendMessages: false, canApprovePermissions: false },
            onJumpToAnchor: undefined,
            message: {
                kind: 'user-text', id: 'row', localId: 'completion', createdAt: 1,
                text: '<happier_execution_run_notification>legacy text</happier_execution_run_notification>',
                meta: { happierStructuredInputV1: { v: 1, executionRunCompletion: {
                    v: 1, runId: 'run_legacy', status: 'failed', finishedAtMs: 1,
                    summary: 'The check found a regression.', canInspect: true,
                } } },
            },
        });
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId="lead" serverId="home-b">
            {element}
        </AppSessionTranscriptSourceProvider>);
        expect(screen.findByTestId('worker-update:run_legacy')).not.toBeNull();
        expect(screen.findByTestId('worker-update-result')?.props.children).toBe('The check found a regression.');
        expect(screen.findByTestId('worker-update-engine')).toBeNull();
        if (isPublic) {
            expect(screen.findByTestId('worker-update-inspect')).toBeNull();
        } else {
            await screen.pressByTestIdAsync('worker-update-inspect');
            expect(routerSpies.push).toHaveBeenCalledWith('/session/lead/runs/run_legacy?serverId=home-b');
        }
    });
});
