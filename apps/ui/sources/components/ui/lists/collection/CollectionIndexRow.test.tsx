import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '../uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Selection is exposed through `accessibilityState` on native; on the web a plain button row omits the
// invalid `aria-selected` (see `Item`), so the native boundary is where this contract is observable.
installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    },
});

const { CollectionIndexRow } = await import('./CollectionIndexRow');

function renderedText(screen: Awaited<ReturnType<typeof renderScreen>>): string {
    return JSON.stringify(screen.tree.toJSON());
}

describe('CollectionIndexRow', () => {
    it('is the collection index: named for the collection, optionally with a fact, opening the index on press', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(
            <CollectionIndexRow testID="rail.all" title="All machines" detail="2 need a look" selected={false} onPress={onPress} />,
        );
        const row = screen.findHostByTestId('rail.all');
        expect(row).toBeTruthy();
        expect(renderedText(screen)).toContain('All machines');
        expect(renderedText(screen)).toContain('2 need a look');
        act(() => { row?.props.onPress?.({}); });
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('marks itself selected only at the collection root, with the same selection the other rail rows draw', async () => {
        const selected = await renderScreen(<CollectionIndexRow testID="a" title="All skills" selected onPress={() => {}} />);
        const idle = await renderScreen(<CollectionIndexRow testID="a" title="All skills" selected={false} onPress={() => {}} />);
        const state = (screen: typeof selected) => screen.findHostByTestId('a')?.props.accessibilityState;
        expect(state(selected)?.selected).toBe(true);
        expect(state(idle)?.selected ?? false).toBe(false);
    });
});
