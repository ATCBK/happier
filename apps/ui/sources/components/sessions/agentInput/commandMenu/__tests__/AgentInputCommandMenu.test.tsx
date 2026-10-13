import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { CommandMenuProps } from '@/components/ui/commandMenu';
import { Popover } from '@/components/ui/popover';
import { makeMutable } from 'react-native-reanimated';
import { ComposerKeyboardProvider, type ComposerKeyboardLayout } from '@/components/sessions/keyboardAvoidance/ComposerKeyboardContext';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'android',
            select: (value: Record<string, unknown>) => value.android ?? value.native ?? value.default ?? value.ios ?? null,
        },
        useWindowDimensions: () => ({ width: 2400, height: 1080 }),
    });
});

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Replace only the portal/window measurement boundary below the real CommandMenu.
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

function buildProps(overrides: Partial<CommandMenuProps> = {}): CommandMenuProps {
    return {
        open: true,
        anchor: { kind: 'view', ref: React.createRef() },
        query: '/',
        items: [],
        selectedIndex: -1,
        onMoveUp: vi.fn(),
        onMoveDown: vi.fn(),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        maxHeight: 240,
        testID: 'agent-input-command-menu',
        ...overrides,
    };
}

describe('AgentInputCommandMenu', () => {
    afterEach(standardCleanup);

    it('applies the agent-input keyboard-safe popover contract on native', async () => {
        // The native composer owns keyboard geometry; consume its real context.
        const layout: ComposerKeyboardLayout = {
            availablePanelHeight: makeMutable(760), bottomInset: makeMutable(320), composerHeight: makeMutable(80),
            isKeyboardLiftSuppressed: makeMutable(false), keyboardHeightForInset: makeMutable(320),
            keyboardHeightLive: makeMutable(320), keyboardProgress: makeMutable(1), listBottomInset: makeMutable(400),
            getKeyboardHeight: () => 320, setComposerMeasuredHeight: () => {},
        };
        const { AgentInputCommandMenu } = await import('../AgentInputCommandMenu');

        const screen = await renderScreen(<ComposerKeyboardProvider layout={layout}>
            <AgentInputCommandMenu {...buildProps()} />
        </ComposerKeyboardProvider>);
        const menu = screen.findAllByType(Popover)[0]?.props;

        expect(menu?.placement).toBe('top');
        expect(menu?.gap).toBe(8);
        expect(menu?.keyboardBottomInset).toBe(320);
        expect(menu?.edgePadding).toEqual({ horizontal: 16, vertical: 16 });
        expect(menu?.consumeOutsidePointerDown).toBe(false);
        expect(menu?.containerStyle).toEqual({ paddingHorizontal: 0 });
        expect(menu?.backdrop).toEqual({
            style: { backgroundColor: 'transparent' },
            blockOutsidePointerEvents: 'above-anchor',
        });
    });
});
