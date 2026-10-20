import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const ROOT_STEP: SelectionListStep = {
    id: 'root',
    inputPlaceholder: 'Search',
    sections: [{
        kind: 'static',
        id: 'section-a',
        options: [
            { id: 'opt-a', label: 'Alpha' },
            { id: 'opt-b', label: 'Bravo' },
            { id: 'opt-c', label: 'Charlie' },
        ],
    }],
};

function props(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: ROOT_STEP, onSelect: vi.fn(), onRequestClose: vi.fn(), keyboardHintsEnabled: false,
        disableTransitions: true, testID: 'sl', ...overrides,
    };
}

async function hoverRow(screen: Awaited<ReturnType<typeof renderScreen>>, id: string): Promise<void> {
    const row = screen.findAllByTestId(`sl:root:option:${id}`).find((node) => typeof node.props?.onHoverIn === 'function');
    expect(row).toBeDefined();
    await act(async () => { (row!.props.onHoverIn as () => void)(); });
}

async function movePointer(screen: Awaited<ReturnType<typeof renderScreen>>): Promise<void> {
    const root = screen.findAllByTestId('sl').find((node) => typeof node.props?.onMouseMove === 'function');
    expect(root).toBeDefined();
    await act(async () => { (root!.props.onMouseMove as () => void)(); });
}

function activeDescendant(screen: Awaited<ReturnType<typeof renderScreen>>): string | undefined {
    return screen.findAllByTestId('sl:header').map((node) => node.props?.activeDescendantId).find((value) => typeof value === 'string');
}

describe('SelectionList pointer focus', () => {
    it('moves the one highlighted row with the pointer in a menu, so hover never paints a second row', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...props({ optionPresentation: 'menu' })} />);
        expect(activeDescendant(screen)).toBe('sl:root:option:opt-a');

        await movePointer(screen);
        await hoverRow(screen, 'opt-c');

        expect(activeDescendant(screen)).toBe('sl:root:option:opt-c');
    });

    it('does not let rows sliding under a resting pointer take the focus back from the keyboard', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...props({ optionPresentation: 'menu' })} />);
        await movePointer(screen);
        await hoverRow(screen, 'opt-c');
        const header = screen.findAllByTestId('sl:header').find((node) => typeof node.props?.onKeyPress === 'function');
        await act(async () => {
            (header!.props.onKeyPress as (event: unknown) => void)({ key: 'ArrowUp', nativeEvent: { key: 'ArrowUp' }, preventDefault: () => {}, stopPropagation: () => {} });
        });
        expect(activeDescendant(screen)).toBe('sl:root:option:opt-b');

        // The list scrolls and the pointer, which has not moved, is now over Charlie again: hover-in only.
        await hoverRow(screen, 'opt-c');
        expect(activeDescendant(screen)).toBe('sl:root:option:opt-b');

        // The next real pointer movement is what moves the highlight.
        await movePointer(screen);
        expect(activeDescendant(screen)).toBe('sl:root:option:opt-c');
    });

    it('leaves cards alone: a card has no focus fill for hover to duplicate', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...props({ optionPresentation: 'card' })} />);
        const before = activeDescendant(screen);

        await movePointer(screen);
        await hoverRow(screen, 'opt-c');

        expect(activeDescendant(screen)).toBe(before);
    });
});
