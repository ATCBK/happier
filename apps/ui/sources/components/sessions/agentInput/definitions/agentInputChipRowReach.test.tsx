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

import { AGENT_INPUT_CHIP_ROW_HIT_REACH, AgentInputChipRowReach } from './agentInputChipRowReach';
import { createPermissionActionChip } from './createPermissionActionChip';

const CHIP_HEIGHT = 32;

function permissionChip() {
    return createPermissionActionChip({
        anchorRef: { current: null },
        tint: '#000',
        showLabel: false,
        label: null,
        chipStyle: () => ({ height: CHIP_HEIGHT, width: 38 }),
        textStyle: {},
        onPress: () => {},
    });
}

describe('AgentInputChipRowReach', () => {
    // The upper row's chips and the lower row's chips are at most 2 px apart: the upper row gives up its
    // reach below, so the two rows' hit areas meet instead of overlapping by the target's full 6 px.
    it('limits a chip to the reach its row declares, and leaves a lone row its full reach', async () => {
        const rowAbove = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <AgentInputChipRowReach reach={AGENT_INPUT_CHIP_ROW_HIT_REACH.upper}>{permissionChip()}</AgentInputChipRowReach>
            </HappierUiPlatformProvider>,
        );
        const stacked = readHitFrameReach(rowAbove.findByTestId('agent-input-permission-chip')!);
        expect(stacked?.bottom).toBe(0.5);
        expect(stacked?.top).toBe(6);

        const alone = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <AgentInputChipRowReach reach={undefined}>{permissionChip()}</AgentInputChipRowReach>
            </HappierUiPlatformProvider>,
        );
        const lone = readHitFrameReach(alone.findByTestId('agent-input-permission-chip')!);
        expect(lone?.bottom).toBe(6);
    });
});
