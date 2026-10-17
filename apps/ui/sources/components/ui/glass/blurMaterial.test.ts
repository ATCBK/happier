import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { installExpoBlurRequireStub } from '@/dev/testkit/mocks/expoBlur';

const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' | 'web' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return platform.OS; } } });
});
const restoreExpoBlur = installExpoBlurRequireStub();
afterAll(restoreExpoBlur);
afterEach(() => { platform.OS = 'ios'; });

// Exercise the actual lazy SDK boundary, including the positive control: an unavailable SDK
// would otherwise make the Android absence assertion pass without exercising the policy.
describe('native blur material', () => {
    it('exposes native blur only on iOS, even after the SDK component has been cached', async () => {
        const { getBlurViewComponent } = await import('./blurMaterial');
        expect(getBlurViewComponent()).not.toBeNull();
        platform.OS = 'android';
        expect(getBlurViewComponent()).toBeNull();
        platform.OS = 'web';
        expect(getBlurViewComponent()).toBeNull();
        platform.OS = 'ios';
        expect(getBlurViewComponent()).not.toBeNull();
    });
});
