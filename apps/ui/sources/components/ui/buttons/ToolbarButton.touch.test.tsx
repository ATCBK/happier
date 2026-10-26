import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

afterEach(() => vi.unstubAllGlobals());

it('draws a coarse-pointer browser toolbar button at its design height and reaches the touch target with the hit frame', async () => {
    // The primary pointer is a browser boundary; the real target policy and button stay mounted.
    vi.stubGlobal('navigator', { maxTouchPoints: 1 });
    const { ToolbarButton } = await import('./ToolbarButton');
    const screen = await renderScreen(<ToolbarButton label="Stop" size="md" testID="touch-toolbar" />);
    const button = () => screen.findByTestId('touch-toolbar')!;
    const raw = typeof button().props.style === 'function'
        ? button().props.style({ hovered: false, pressed: false, focused: false })
        : button().props.style;
    const style = Object.assign({}, ...[raw].flat(Infinity).filter(Boolean));
    // A touch target is a hit area, not a drawn size (DESIGN.md): the md toolbar button stays 34 high.
    expect(style.minHeight).toBe(34);
    await act(async () => {
        button().props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 72, height: 34 } } });
    });
    const frame = screen.root.findAll((node) => node.props?.dataSet?.happierHitArea === 'true')[0];
    expect(frame?.props.style).toMatchObject({ top: -5, bottom: -5 });
});
