import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hardware = vi.hoisted(() => ({ platform: 'ios', catalyst: false, type: 1 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() { return hardware.platform; },
            constants: { get isMacCatalyst() { return hardware.catalyst; } },
        },
    });
});
vi.mock('expo-device', () => ({
    DeviceType: { UNKNOWN: 0, PHONE: 1, TABLET: 2, DESKTOP: 4 },
    get deviceType() { return hardware.type; },
}));

import { isPhoneHardware } from './isPhoneHardware';

describe('phone hardware defaults', () => {
    afterEach(() => vi.unstubAllGlobals());
    beforeEach(() => {
        hardware.platform = 'ios';
        hardware.catalyst = false;
        hardware.type = 1;
        vi.unstubAllGlobals();
    });

    it('distinguishes native phones from tablets, unknown devices and Catalyst without a viewport', () => {
        expect(isPhoneHardware()).toBe(true);
        hardware.platform = 'android';
        expect(isPhoneHardware()).toBe(true);
        hardware.type = 2;
        expect(isPhoneHardware()).toBe(false);
        hardware.type = 0;
        expect(isPhoneHardware()).toBe(false);
        hardware.type = 1;
        hardware.platform = 'ios';
        hardware.catalyst = true;
        expect(isPhoneHardware()).toBe(false);
    });

    it('uses the existing mobile-browser hardware classification independently of window width', () => {
        hardware.platform = 'web';
        vi.stubGlobal('navigator', { userAgent: 'Windows NT', maxTouchPoints: 0 });
        vi.stubGlobal('window', { innerWidth: 390, innerHeight: 844 });
        expect(isPhoneHardware()).toBe(false);
        vi.stubGlobal('navigator', { userAgent: 'iPhone', maxTouchPoints: 1 });
        expect(isPhoneHardware()).toBe(true);
        vi.stubGlobal('window', { innerWidth: 1440, innerHeight: 900 });
        expect(isPhoneHardware()).toBe(true);
    });
});
