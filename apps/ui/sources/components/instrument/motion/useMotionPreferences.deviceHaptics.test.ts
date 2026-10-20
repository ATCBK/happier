import { afterEach, describe, expect, it } from 'vitest';
import { Platform } from 'react-native';
import { act, renderHook } from '@/dev/testkit';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useMotionPreferences } from './useMotionPreferences';

const originalPlatform = Platform.OS;
afterEach(() => {
    Reflect.set(Platform, 'OS', originalPlatform);
    setReducedMotionPreferenceOverride(null);
    getStorage().getState().applyLocalSettings({ hapticsEnabled: true });
});

describe('instrument device haptic preference', () => {
    it('updates mounted consumers when this device opts out, independently of reduced motion', async () => {
        Reflect.set(Platform, 'OS', 'ios');
        setReducedMotionPreferenceOverride(true);
        getStorage().getState().applyLocalSettings({ hapticsEnabled: true });
        const hook = await renderHook(() => useMotionPreferences());
        try {
            expect(hook.getCurrent()).toMatchObject({ level: 'minimal', hapticsEnabled: true });
            await act(async () => { getStorage().getState().applyLocalSettings({ hapticsEnabled: false }); });
            expect(hook.getCurrent()).toMatchObject({ level: 'minimal', hapticsEnabled: false });
            await act(async () => { getStorage().getState().applyLocalSettings({ hapticsEnabled: true }); });
            expect(hook.getCurrent().hapticsEnabled).toBe(true);
        } finally {
            await hook.unmount();
        }
    });
});
