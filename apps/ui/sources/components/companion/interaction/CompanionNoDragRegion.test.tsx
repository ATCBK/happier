import * as React from 'react';
import { act } from 'react-test-renderer';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'web' }));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    const native = await createReactNativeNativeMock({ platformOS: 'ios' });
    return { ...native, Platform: {
        ...native.Platform,
        get OS() { return platform.os; },
        select: <T,>(options: Readonly<{ ios?: T; web?: T; native?: T; default?: T }>) =>
            options[platform.os] ?? (platform.os === 'ios' ? options.native : undefined) ?? options.default,
    } };
});
afterEach(() => { platform.os = 'ios'; });

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';

import {
    CompanionNoDragRegion,
    CompanionNoDragRegionProvider,
    type CompanionNoDragRegionRect,
    pointIntersectsCompanionNoDragRegions,
    useCompanionNoDragRegions,
} from './CompanionNoDragRegion';

function NoDragProbe(props: Readonly<{
    onRegionsChange: (regions: readonly CompanionNoDragRegionRect[]) => void;
}>): React.ReactElement {
    const regions = useCompanionNoDragRegions();

    props.onRegionsChange(regions);

    return <View testID="pet-no-drag-probe" />;
}

describe('CompanionNoDragRegion', () => {
    it.each(['ios', 'web'] as const)('keeps %s admission current without publishing redundant native layout snapshots', async (os) => {
        platform.os = os;
        let observed: readonly CompanionNoDragRegionRect[] = [];
        const screen = await renderScreen(<CompanionNoDragRegionProvider>
            <CompanionNoDragRegion testID="moving-control">
                <NoDragProbe onRegionsChange={(regions) => { observed = regions; }} />
            </CompanionNoDragRegion>
        </CompanionNoDragRegionProvider>);
        const layout = async (x: number) => act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('moving-control'), 'onLayout', {
                nativeEvent: { layout: { x, y: 32, width: 80, height: 36 } },
            });
        });
        await layout(24);
        const initial = observed;
        await layout(120);
        if (os === 'ios') {
            // Native admission measures this stable ref on the UI thread, not these layout coordinates.
            expect(observed[0].nativeRef).toBeDefined();
            expect(observed).toBe(initial);
        } else {
            expect(observed[0].nativeRef).toBeUndefined();
            expect(observed[0].x).toBe(120);
        }
        await screen.unmount();
    });
    it('registers measured native no-drag regions through context', async () => {
        let observedRegions: readonly CompanionNoDragRegionRect[] = [];
        const screen = await renderScreen(
            <CompanionNoDragRegionProvider>
                <CompanionNoDragRegion testID="pet-tray-action-no-drag">
                    <NoDragProbe onRegionsChange={(regions) => {
                        observedRegions = regions;
                    }} />
                </CompanionNoDragRegion>
            </CompanionNoDragRegionProvider>,
        );

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('pet-tray-action-no-drag'), 'onLayout', {
                nativeEvent: {
                    layout: { x: 24, y: 32, width: 80, height: 36 },
                },
            });
        });

        expect(screen.findByTestId('pet-no-drag-probe')).toBeTruthy();
        expect(observedRegions).toHaveLength(1);
        expect(observedRegions[0]).toEqual(expect.objectContaining({
            x: 24,
            y: 32,
            width: 80,
            height: 36,
        }));
    });

    it('detects whether a touch point is inside a registered no-drag region', () => {
        const regions = [{ id: 'menu', x: 24, y: 32, width: 80, height: 36 }] as const;

        expect(pointIntersectsCompanionNoDragRegions({ x: 24, y: 32 }, regions)).toBe(true);
        expect(pointIntersectsCompanionNoDragRegions({ x: 103, y: 67 }, regions)).toBe(true);
        expect(pointIntersectsCompanionNoDragRegions({ x: 104.1, y: 67 }, regions)).toBe(false);
        expect(pointIntersectsCompanionNoDragRegions({ x: 60, y: 80 }, regions)).toBe(false);
    });
});
