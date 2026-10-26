import * as React from 'react';
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

import { CollectionSpacesStrip } from './CollectionSpacesStrip';

describe('CollectionSpacesStrip', () => {
    // The + sits between the list title above and the group labels below: its hit area leaves the strip's 4 px
    // insets to their own reach, and splits the 2 px gap to the last space tab, so no two hit areas overlap.
    it('keeps the new-space hit area out of the title above it and the tab beside it', async () => {
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <CollectionSpacesStrip
                    testIDPrefix="spaces"
                    accessibilityLabel="Spaces"
                    items={[{ id: 'a', name: 'Mine', icon: { kind: 'icon', name: 'list' } }]}
                    selectedId="a"
                    onSelect={() => {}}
                    addLabel="New space"
                    onAdd={() => {}}
                />
            </HappierUiPlatformProvider>,
        );
        const reach = readHitFrameReach(screen.findByTestId('spaces-add')!);
        expect(reach?.top).toBe(0);
        expect(reach?.left).toBe(1);
        expect(reach?.bottom).toBe(0);
    });
});
