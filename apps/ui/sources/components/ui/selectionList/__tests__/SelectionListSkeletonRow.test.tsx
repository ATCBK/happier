import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function mergedStyle(style: unknown): Record<string, unknown> {
    const flat = (Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean);
    return Object.assign({}, ...flat);
}

describe('selection list loading row (the shared loading rows in the option row shape)', () => {
    it('reserves the option row height and stays hidden from assistive tech on every platform', async () => {
        const { SkeletonRows } = await import('@/components/ui/lists/SkeletonRows');
        const { SELECTION_LIST_SKELETON_ROW_SHAPE, SELECTION_LIST_SKELETON_ROW_HEIGHT_PX } = await import('../_constants');
        const screen = await renderScreen(
            <SkeletonRows rows={1} firstIndex={2} {...SELECTION_LIST_SKELETON_ROW_SHAPE} rowTestID="sk" />,
        );
        const row = screen.findByTestId('sk');
        expect(row).not.toBeNull();
        // The row reserves the final option geometry, so loading → ready does not move the popover.
        expect(mergedStyle(row!.props.style).height).toBe(SELECTION_LIST_SKELETON_ROW_HEIGHT_PX);
        expect(row!.props.accessibilityElementsHidden).toBe(true);
        expect(row!.props.importantForAccessibility).toBe('no-hide-descendants');
    });
});
