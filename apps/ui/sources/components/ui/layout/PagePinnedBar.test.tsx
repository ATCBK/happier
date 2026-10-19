import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StyleSheet } from 'react-native';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ModalBoundaryProvider } from '@/modal/context/ModalBoundaryContext';
import { SessionCockpitBottomChromeHeightContext } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// The device's home-indicator inset is the platform boundary.
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

const { PagePinnedBar } = await import('./PagePinnedBar');

afterEach(() => standardCleanup());

async function bottomPadding(input: Readonly<{ chromeHeight: number; inModal?: boolean }>): Promise<number> {
    const bar = (
        <SessionCockpitBottomChromeHeightContext.Provider value={input.chromeHeight}>
            <PagePinnedBar testID="bar" />
        </SessionCockpitBottomChromeHeightContext.Provider>
    );
    const screen = await renderScreen(input.inModal ? <ModalBoundaryProvider>{bar}</ModalBoundaryProvider> : bar);
    return Number(StyleSheet.flatten(screen.findByTestId('bar')!.props.style)?.paddingBottom);
}

describe('PagePinnedBar', () => {
    it('keeps its actions above a floating tab bar by the bar\'s measured height', async () => {
        const clear = await bottomPadding({ chromeHeight: 0 });
        expect(await bottomPadding({ chromeHeight: 84 })).toBeGreaterThanOrEqual(84);
        // Reserving the chrome replaces the safe-area clearance (the tab bar already carries it).
        expect(await bottomPadding({ chromeHeight: 84 })).toBeLessThan(84 + clear);
    });

    it('clears the system safe area when no tab bar overlays the page', async () => {
        expect(await bottomPadding({ chromeHeight: 0 })).toBe(34);
    });

    it('does not reserve a tab bar that a modal covers', async () => {
        expect(await bottomPadding({ chromeHeight: 84, inModal: true })).toBe(34);
    });
});
