import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

afterEach(() => vi.unstubAllGlobals());

it('gives a coarse-pointer browser the platform touch target as real box, not overlapping slop', async () => {
    // The primary pointer is a browser boundary; the real target policy and button stay mounted.
    vi.stubGlobal('navigator', { maxTouchPoints: 1 });
    const { ToolbarButton } = await import('./ToolbarButton');
    const { resolveMinimumInteractiveTargetSize } = await import('../interactiveTargetSize');
    const screen = await renderScreen(<ToolbarButton label="Stop" size="md" testID="touch-toolbar" />);
    const button = screen.findByTestId('touch-toolbar')!;
    const raw = typeof button.props.style === 'function'
        ? button.props.style({ hovered: false, pressed: false, focused: false })
        : button.props.style;
    const style = Object.assign({}, ...[raw].flat(Infinity).filter(Boolean));
    expect(style.minHeight).toBeGreaterThanOrEqual(resolveMinimumInteractiveTargetSize('web'));
    expect(button.props.hitSlop ?? 0).toBe(0);
});
