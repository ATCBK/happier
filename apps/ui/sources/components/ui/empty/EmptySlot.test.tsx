import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

const { GlassSurface } = await import('@/components/ui/glass/GlassSurface');
const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
const { EmptySlot } = await import('./EmptySlot');

async function slotOn(behind: 'none' | 'band' | 'wallpaper', inside: 'plane' | 'card' = 'plane') {
    const slot = <EmptySlot testID="slot" label="Add widget" labelRole="row" icon="plus" onPress={() => {}} />;
    const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: behind }}>
        <GlassSurface plane surfaceGroup="content" finishRole={null}>
            {inside === 'card' ? <GlassSurface surfaceGroup="card" finishRole={null}>{slot}</GlassSurface> : slot}
        </GlassSurface>
    </GlassRuntimeEnvironmentProvider>);
    // Elements around the slot: its own ground, or (in the 'card' scene) the card the scene put it in.
    return screen.findAllByType(GlassSurface).filter(node => node.props.surfaceGroup === 'card'
        && node.findAll(inner => inner.props.testID === 'slot').length > 0).length;
}

afterEach(() => { standardCleanup(); });

describe('the empty slot', () => {
    it('stands on Elements where the cleared page is the Wallpaper picture itself, so its line never sits on raw pixels', async () => {
        expect(await slotOn('wallpaper')).toBe(1);
    });

    it('draws no ground of its own on the page colour, under a band, or inside a card that already is its ground', async () => {
        expect(await slotOn('none')).toBe(0);
        expect(await slotOn('band')).toBe(0);
        expect(await slotOn('wallpaper', 'card')).toBe(1);
    });
});
