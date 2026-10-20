import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import {
    installSessionActionsCommonModuleMocks,
    resetSessionActionsCommonModuleMockState,
} from './sessionActionsTestHelpers';
import { SESSION_DETAILS_TERMINAL_TAB_KEY } from '@/components/sessions/terminal/embeddedTerminalDocking';

let useRealPane = false;
let dockLocationMock: 'bottom' | 'details' | 'sidebar' = 'bottom';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionActionsCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: (key: string) => {
                if (key === 'embeddedTerminalDockLocation') return dockLocationMock;
                return null;
            },
        });
    },
});

const openBottomSpy = vi.fn();
const closeBottomSpy = vi.fn();
const setBottomTabSpy = vi.fn();
const openRightSpy = vi.fn();
const closeRightSpy = vi.fn();
const setRightTabSpy = vi.fn();
const openDetailsTabSpy = vi.fn();
const closeDetailsTabSpy = vi.fn();

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'terminal-instance-1',
}));

const pane: AppPaneScopeApi = {
    scopeId: 'session:s1',
    scopeState: {
        right: { isOpen: false, activeTabId: null as string | null, selectedDestination: null, tabState: {} },
        details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
        bottom: { isOpen: false, activeTabId: null as string | null, selectedDestination: null, tabState: {} },
    },
    openRight: openRightSpy,
    closeRight: closeRightSpy,
    setRightTab: setRightTabSpy,
    selectRightDestination: vi.fn(),
    setRightTabState: vi.fn(),
    openBottom: openBottomSpy,
    closeBottom: closeBottomSpy,
    setBottomTab: setBottomTabSpy,
    selectBottomDestination: vi.fn(),
    setBottomTabState: vi.fn(),
    openDetailsTab: openDetailsTabSpy,
    replaceDetailsTab: vi.fn(),
    setDetailsTabState: vi.fn(),
    patchDetailsTabState: vi.fn(),
    pinDetailsTab: vi.fn(),
    unpinDetailsTab: vi.fn(),
    closeDetails: vi.fn(),
    closeDetailsTab: closeDetailsTabSpy,
    setActiveDetailsTab: vi.fn(),
};

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/appShell/panes/hooks/useAppPaneScope')>();
    return { useAppPaneScope: (scopeId: string) => useRealPane ? actual.useAppPaneScope(scopeId) : pane };
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

describe('SessionHeaderTerminalButton', () => {
    beforeEach(() => {
        useRealPane = false;
        resetSessionActionsCommonModuleMockState();
        openBottomSpy.mockClear();
        closeBottomSpy.mockClear();
        setBottomTabSpy.mockClear();
        openRightSpy.mockClear();
        closeRightSpy.mockClear();
        setRightTabSpy.mockClear();
        openDetailsTabSpy.mockClear();
        closeDetailsTabSpy.mockClear();
        dockLocationMock = 'bottom';
        const scopeState = pane.scopeState;
        if (!scopeState) {
            throw new Error('Expected pane scope state');
        }
        scopeState.bottom.isOpen = false;
        scopeState.bottom.activeTabId = null;
        scopeState.details.isOpen = false;
        scopeState.details.activeTabKey = null;
        scopeState.details.tabs = [];
    });

    it('opens terminal in the bottom pane when docked to bottom', async () => {
        const { SessionHeaderTerminalButton } = await import('./SessionHeaderTerminalButton');

        const screen = await renderScreen(<SessionHeaderTerminalButton sessionId="s1" scopeId="session:s1" />);
        expect(screen.findByTestId('session-header-terminal-button')).toBeTruthy();

        await screen.pressByTestIdAsync('session-header-terminal-button');

        expect(openBottomSpy).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(setBottomTabSpy).toHaveBeenCalledWith('terminal');
        expect(closeBottomSpy).not.toHaveBeenCalled();
    });

    it('closes the bottom pane when terminal is already open there', async () => {
        const scopeState = pane.scopeState;
        if (!scopeState) {
            throw new Error('Expected pane scope state');
        }
        scopeState.bottom.isOpen = true;
        scopeState.bottom.activeTabId = 'terminal';

        const { SessionHeaderTerminalButton } = await import('./SessionHeaderTerminalButton');

        const screen = await renderScreen(<SessionHeaderTerminalButton sessionId="s1" scopeId="session:s1" />);
        expect(screen.findByTestId('session-header-terminal-button')).toBeTruthy();

        await screen.pressByTestIdAsync('session-header-terminal-button');

        expect(closeBottomSpy).toHaveBeenCalledTimes(1);
        expect(openBottomSpy).not.toHaveBeenCalled();
    });

    it('opens the bottom pane on desktop even when a retired dock choice is still stored (terminal lab B1)', async () => {
        dockLocationMock = 'details';
        const { SessionHeaderTerminalButton } = await import('./SessionHeaderTerminalButton');

        const screen = await renderScreen(<SessionHeaderTerminalButton sessionId="s1" scopeId="session:s1" />);
        await screen.pressByTestIdAsync('session-header-terminal-button');

        expect(openBottomSpy).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(openDetailsTabSpy).not.toHaveBeenCalled();
    });

    it('suppresses the header terminal button testID when the session screen is hidden', async () => {
        const { SessionScreenTestIdsProvider } = await import('../shell/sessionScreenTestIds');
        const { SessionHeaderTerminalButton } = await import('./SessionHeaderTerminalButton');

        const screen = await renderScreen(
            <SessionScreenTestIdsProvider enabled={false}>
                <SessionHeaderTerminalButton sessionId="s1" scopeId="session:s1" />
            </SessionScreenTestIdsProvider>,
        );

        expect(screen.findByTestId('session-header-terminal-button')).toBeNull();
    });
});
