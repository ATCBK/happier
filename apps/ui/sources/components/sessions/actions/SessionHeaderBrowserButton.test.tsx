import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { FeatureDecision } from '@happier-dev/protocol';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import {
    installSessionActionsCommonModuleMocks,
    resetSessionActionsCommonModuleMockState,
} from './sessionActionsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSessionActionsCommonModuleMocks();

const openDetailsTabSpy = vi.fn();
const closeRightSpy = vi.fn();
const openRightSpy = vi.fn();

let deviceTypeMock: 'phone' | 'tablet' | 'desktop' = 'desktop';

const enabledDecision = {
    featureId: 'browser',
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: 1_000,
    scope: { scopeKind: 'runtime' },
} satisfies FeatureDecision;

const disabledDecision = {
    featureId: 'browser',
    state: 'disabled',
    blockedBy: 'server',
    blockerCode: 'feature_disabled',
    diagnostics: [],
    evaluatedAt: 1_000,
    scope: { scopeKind: 'runtime' },
} satisfies FeatureDecision;

let browserDecisionMock: FeatureDecision = enabledDecision;
let viewTargetsDecisionMock: FeatureDecision = enabledDecision;

const pane: AppPaneScopeApi = {
    scopeId: 'session:s1',
    scopeState: {
        mainHidden: false,
        right: { isOpen: false, activeTabId: null as string | null, selectedDestination: null, tabState: {} },
        details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
        bottom: { isOpen: false, activeTabId: null as string | null, selectedDestination: null, tabState: {} },
    },
    openRight: openRightSpy,
    closeRight: closeRightSpy,
    setRightTab: vi.fn(),
    selectRightDestination: vi.fn(),
    setRightTabState: vi.fn(),
    openBottom: vi.fn(),
    closeBottom: vi.fn(),
    setBottomTab: vi.fn(),
    selectBottomDestination: vi.fn(),
    setBottomTabState: vi.fn(),
    openDetailsTab: openDetailsTabSpy,
    replaceDetailsTab: vi.fn(),
    setDetailsTabState: vi.fn(),
    patchDetailsTabState: vi.fn(),
    pinDetailsTab: vi.fn(),
    unpinDetailsTab: vi.fn(),
    closeDetails: vi.fn(),
    closeDetailsTab: vi.fn(),
    setActiveDetailsTab: vi.fn(),
};

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => pane,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeMock,
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => (
        featureId === 'browser.viewTargets' ? viewTargetsDecisionMock : browserDecisionMock
    ),
}));

describe('SessionHeaderBrowserButton', () => {
    beforeEach(() => {
        resetSessionActionsCommonModuleMockState();
        openDetailsTabSpy.mockClear();
        closeRightSpy.mockClear();
        openRightSpy.mockClear();
        vi.mocked(pane.selectRightDestination).mockClear();
        deviceTypeMock = 'desktop';
        browserDecisionMock = enabledDecision;
        viewTargetsDecisionMock = enabledDecision;
        const scopeState = pane.scopeState;
        if (!scopeState) throw new Error('Expected pane scope state');
        scopeState.details.isOpen = false;
        scopeState.details.activeTabKey = null;
        scopeState.details.tabs = [];
    });

    it('renders on desktop when the browser feature is enabled', async () => {
        const { SessionHeaderBrowserButton } = await import('./SessionHeaderBrowserButton');
        const screen = await renderScreen(<SessionHeaderBrowserButton sessionId="s1" scopeId="session:s1" />);
        expect(screen.findByTestId('session-header-browser-button')).toBeTruthy();
    });

    it('is absent on mobile (phone) — the mobile sidebar already hosts the browser surface', async () => {
        deviceTypeMock = 'phone';
        const { SessionHeaderBrowserButton } = await import('./SessionHeaderBrowserButton');
        const screen = await renderScreen(<SessionHeaderBrowserButton sessionId="s1" scopeId="session:s1" />);
        expect(screen.findByTestId('session-header-browser-button')).toBeNull();
    });

    it('is absent when the browser feature decision is disabled', async () => {
        browserDecisionMock = disabledDecision;
        const { SessionHeaderBrowserButton } = await import('./SessionHeaderBrowserButton');
        const screen = await renderScreen(<SessionHeaderBrowserButton sessionId="s1" scopeId="session:s1" />);
        expect(screen.findByTestId('session-header-browser-button')).toBeNull();
    });

    it('is absent when the browser.viewTargets decision is disabled', async () => {
        viewTargetsDecisionMock = disabledDecision;
        const { SessionHeaderBrowserButton } = await import('./SessionHeaderBrowserButton');
        const screen = await renderScreen(<SessionHeaderBrowserButton sessionId="s1" scopeId="session:s1" />);
        expect(screen.findByTestId('session-header-browser-button')).toBeNull();
    });

    it('opens the Browser dock destination without creating a competing Details launchpad', async () => {
        const { SessionHeaderBrowserButton } = await import('./SessionHeaderBrowserButton');
        const screen = await renderScreen(<SessionHeaderBrowserButton sessionId="s1" scopeId="session:s1" />);

        await screen.pressByTestIdAsync('session-header-browser-button');

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'browser', present: false });
        expect(openDetailsTabSpy).not.toHaveBeenCalled();
        // It must never toggle/close an existing pane.
        expect(closeRightSpy).not.toHaveBeenCalled();
    });

    it('keeps existing Details work when opening the Browser dock destination', async () => {
        const scopeState = pane.scopeState;
        if (!scopeState) throw new Error('Expected pane scope state');
        scopeState.details.isOpen = true;
        scopeState.details.activeTabKey = 'file:src/index.ts';
        scopeState.details.tabs = [{
            key: 'file:src/index.ts',
            kind: 'file',
            title: 'index.ts',
            isPinned: true,
            isPreview: false,
            resource: { kind: 'file', path: 'src/index.ts' },
        }];

        const { SessionHeaderBrowserButton } = await import('./SessionHeaderBrowserButton');
        const screen = await renderScreen(<SessionHeaderBrowserButton sessionId="s1" scopeId="session:s1" />);

        await screen.pressByTestIdAsync('session-header-browser-button');

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'browser', present: false });
        expect(openDetailsTabSpy).not.toHaveBeenCalled();
        expect(pane.closeDetails).not.toHaveBeenCalled();
        expect(closeRightSpy).not.toHaveBeenCalled();
    });
});
