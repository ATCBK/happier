import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { storage } from '@/sync/domains/state/storageStore';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { clearTempData, storeTempData } from '@/utils/sessions/tempDataStore';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let routeParams: Record<string, string | string[]> = {
        id: ['', 's1'],
        serverId: ['server-1'],
        jumpSeq: '42',
        right: 'files',
        bottom: 'terminal',
        details: 'commit',
        path: 'src/index.ts',
        sha: 'abc123',
        recoveryDataId: 'recovery-1',
    };
const attachmentDraft: AttachmentDraft = {
    id: 'draft-1', source: { kind: 'memory', bytes: new Uint8Array(), name: 'draft.txt', mimeType: 'text/plain' },
    status: 'uploaded', uploadedPath: 'attachments/draft.txt', uploadedSizeBytes: 0,
};
installSessionRouteCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
        { platformOS: 'ios' }, { Platform: { isPad: true },
            useWindowDimensions: () => ({ width: 1280, height: 900, scale: 1, fontScale: 1 }) }),
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: () => routeParams }).module,
    nativeNavigation: async () => (await import('@/dev/testkit/mocks/reactNavigation'))
        .createReactNavigationNativeMock({ renderInitialNavigatorScreen: true }),
});
const runtime = installSessionPaneRuntimeTestHarness({ sessionId: 's1' });
let hydration: typeof import('@/hooks/session/useHydrateSessionForRoute');
let serverRuntime: typeof import('@/sync/domains/server/serverRuntime');
let hydrateSessionSpy: MockInstance<typeof hydration.useHydrateSessionForRoute>;
let SessionView: typeof import('@/components/sessions/shell/SessionView')['SessionView'];
beforeEach(async () => {
    clearTempData();
    routeParams = {
        id: ['', 's1'],
        serverId: ['server-1'],
        jumpSeq: '42',
        right: 'files',
        bottom: 'terminal',
        details: 'commit',
        path: 'src/index.ts',
        sha: 'abc123',
        recoveryDataId: 'recovery-1',
    };
    routeParams.serverId = [runtime.serverId];
    routeParams.recoveryDataId = storeTempData({ attachmentDrafts: [attachmentDraft] });
    storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'classic' });
    hydration = await import('@/hooks/session/useHydrateSessionForRoute');
    serverRuntime = await import('@/sync/domains/server/serverRuntime');
    hydrateSessionSpy = vi.spyOn(hydration, 'useHydrateSessionForRoute');
    ({ SessionView } = await import('@/components/sessions/shell/SessionView'));
});
afterEach(() => {
    standardCleanup();
    clearTempData();
    vi.restoreAllMocks();
});
describe('Session route params', () => {
    it('normalizes route params before hydrating and passes the full session route boundary to the Session view', async () => {
        const { default: SessionRoute } = await import('@/app/(app)/session/[id]/index');
        const screen = await renderScreen(<runtime.Wrapper><SessionRoute /></runtime.Wrapper>);
        expect(hydrateSessionSpy).toHaveBeenCalledWith('s1',
            'SessionRoute.ensureSessionVisible gen=' + serverRuntime.getActiveServerSnapshot().generation,
            { serverId: runtime.serverId });
        expect(screen.findByType(SessionView).props).toEqual(expect.objectContaining({
            id: 's1', routeServerId: runtime.serverId, jumpToSeq: 42,
            paneUrlState: { rightTabId: 'files', bottomTabId: 'terminal', details: { kind: 'commit', sha: 'abc123' } },
            initialAttachmentDrafts: [attachmentDraft],
        }));
        // A selected file and a selected commit are distinct URL resources. Exercise
        // both through the real parser rather than manufacturing a combined target.
        routeParams = { ...routeParams, details: 'file' };
        await act(async () => screen.update(<runtime.Wrapper><SessionRoute /></runtime.Wrapper>));
        expect(screen.findByType(SessionView).props).toEqual(expect.objectContaining({
            id: 's1', routeServerId: runtime.serverId, jumpToSeq: 42,
            paneUrlState: { rightTabId: 'files', bottomTabId: 'terminal', details: { kind: 'file', path: 'src/index.ts' } },
        }));
    });
});
