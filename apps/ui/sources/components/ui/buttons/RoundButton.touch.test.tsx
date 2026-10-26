import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

afterEach(() => vi.unstubAllGlobals());

it('draws a coarse-web button at its design size and reaches the touch target with its hit area', async () => {
    // The primary pointer is a browser boundary; the real target policy and button stay mounted.
    vi.stubGlobal('navigator', { maxTouchPoints: 1 });
    const { RoundButton } = await import('./RoundButton');
    const screen = await renderScreen(<RoundButton size="normal" title="Go" testID="touch-button" />);
    const button = screen.findByTestId('touch-button')!;
    const style = Object.assign({}, ...[button.props.style].flat().filter(Boolean));
    // A finger's target is a hit area, never a drawn size (DESIGN.md): the pill keeps its own height.
    expect(style.minHeight).toBeUndefined();
    expect(style.minWidth).toBeUndefined();
    // The web ignores hitSlop, so the reach is the shared pressable's invisible hit frame, sized from
    // the drawn pill once layout measures it.
    const onLayout = button.props.onLayout as ((event: unknown) => void) | undefined;
    expect(onLayout).toBeTypeOf('function');
    await act(async () => onLayout!({ nativeEvent: { layout: { x: 0, y: 0, width: 60, height: 30 } } }));
    const hitFrames = screen.root.findAll((node) => node.props?.dataSet?.happierHitArea === 'true');
    expect(hitFrames.length).toBeGreaterThan(0);
});
