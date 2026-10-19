import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { View } from 'react-native';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { WidgetPreviewStage } from './WidgetPreviewStage';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

afterEach(() => standardCleanup());

const layout = (width: number, height: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height } } });

/** The stage at a measured room: its frame (what is drawn) and the surface laid out inside it. */
async function stageAt(room: number) {
    const screen = await renderScreen(
        <WidgetPreviewStage surface="sessionBoard" size="medium" caption="Preview" accessibilityLabel="Directory count" testID="stage">
            <View testID="stage.card" />
        </WidgetPreviewStage>,
    );
    // The stage's measured views, in order: its room, then the laid-out surface holding the card.
    const measured = () => screen.root.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function');
    await act(async () => { measured()[0]!.props.onLayout(layout(room, 600)); });
    await act(async () => { measured()[1]!.props.onLayout(layout(room, 220)); });
    const style = (node: ReturnType<typeof measured>[number]) => Object.assign({}, ...[node.props.style].flat(3).filter(Boolean));
    const surface = measured()[1]!;
    return { screen, surface: style(surface), frame: style(surface.parent!) };
}

describe('WidgetPreviewStage', () => {
    it('draws the card at real size across a pane narrower than the surface columns (FA21 S2)', async () => {
        // A Session's pane is one column: a Medium card there spans the pane, as the board draws it.
        const { screen, surface, frame } = await stageAt(360);
        expect(frame.width).toBe(360);
        expect(surface.transform).toEqual([{ scale: 1 }]);
        expect(screen.findByTestId('stage.ghost')).toBeNull();
    });
});
