import * as React from 'react';
import { Text } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { readHitFrameReach } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

import { SetupBlockPaper } from './SetupBlockPaper';

describe('SetupBlockPaper', () => {
    // A card sits right under its section's ⋯ (15 px between the two drawn controls, and the ⋯'s own hit
    // area reaches 8 px below it): the ✕ takes only the 7 px left above it, so the two hit areas meet and
    // never overlap, while its free sides keep their full reach.
    it('keeps a card dismiss out of the section menu above it', async () => {
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <SetupBlockPaper testID="tile" layout="card" dismiss={{ label: 'Hide', onPress: () => {} }}>
                    <Text>Body</Text>
                </SetupBlockPaper>
            </HappierUiPlatformProvider>,
        );
        const reach = readHitFrameReach(screen.findByTestId('tile.dismiss')!);
        expect(reach?.top).toBe(7);
        expect(reach?.bottom).toBe(10);
        expect(reach?.left).toBe(10);
    });
});
