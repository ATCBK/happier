import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pathnameState = vi.hoisted(() => ({ value: '/settings' }));
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const viewport = vi.hoisted(() => ({ width: 1200, height: 800 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Dimensions: { get: () => ({ width: viewport.width, height: viewport.height }) },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => pathnameState.value,
        router: { replace: routerReplaceSpy },
    }).module;
});

const { SettingsPresentationRouteKeeper } = await import('./SettingsPresentationRouteKeeper');

type DeviceType = 'phone' | 'tablet';

async function mountKeeper(deviceType: DeviceType) {
    return await renderScreen(<SettingsPresentationRouteKeeper deviceType={deviceType} />);
}

describe('SettingsPresentationRouteKeeper', () => {
    afterEach(() => {
        pathnameState.value = '/settings';
        viewport.width = 1200;
        viewport.height = 800;
        routerReplaceSpy.mockReset();
    });

    it('reopens the settings page that was showing when a phone/desktop switch remounted Settings', async () => {
        pathnameState.value = '/settings/session/transcript';
        const before = await mountKeeper('tablet');

        // The window narrows: Settings is presented differently and its navigator remounts at the index.
        viewport.width = 390;
        viewport.height = 844;
        await act(async () => { before.tree.unmount(); });
        // The pathname still names the old page while the new navigator sits at its index (seen live).
        const after = await mountKeeper('phone');

        expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/session/transcript');
        await act(async () => { after.tree.unmount(); });
    });

    it('leaves Settings where it opens after an ordinary close', async () => {
        pathnameState.value = '/settings/session/transcript';
        const before = await mountKeeper('tablet');

        await act(async () => { before.tree.unmount(); });
        pathnameState.value = '/settings';
        await mountKeeper('tablet');

        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });
});
