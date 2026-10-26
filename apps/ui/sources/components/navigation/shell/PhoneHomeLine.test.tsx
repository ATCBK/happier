import * as React from 'react';
import { act } from 'react-test-renderer';
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

import { PhoneHomeLine } from './PhoneHomeLine';

describe('PhoneHomeLine', () => {
    // The large title starts 9 px under the line and its own hit area reaches 4 px up: the line leaves
    // that to the title and takes the rest, so the two hit areas meet without overlapping.
    it('keeps its hit area above the large title under it', async () => {
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <PhoneHomeLine state={{
                    open: false, activate: () => {}, homeLabel: 'This Home', statusLabel: 'Connected', statusColor: '#0a84ff',
                    needsAttention: false, connecting: false, accessibilityLabel: 'This Home, Connected', accountService: { kind: 'none' },
                }} />
            </HappierUiPlatformProvider>,
        );
        const line = screen.findByTestId('main-header-home-line')!;
        await act(async () => { line.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 78, height: 20 } } }); });
        const reach = readHitFrameReach(line);
        expect(reach?.bottom).toBeLessThanOrEqual(4);
        expect(reach?.top).toBeGreaterThan(0);
    });
});
