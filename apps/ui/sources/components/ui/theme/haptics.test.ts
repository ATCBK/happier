import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

const native = vi.hoisted(() => ({
    selectionAsync: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    impactAsync: vi.fn<(style: string) => Promise<void>>(() => Promise.resolve()),
    notificationAsync: vi.fn<(type: string) => Promise<void>>(() => Promise.resolve()),
    performAndroidHapticsAsync: vi.fn<(type: string) => Promise<void>>(() => Promise.resolve()),
}));

// Expo owns the physical native feedback engine; adapter and storage policy remain real.
vi.mock('expo-haptics', () => ({
    ...native,
    AndroidHaptics: { Drag_Start: 'drag-start', Segment_Tick: 'segment-tick', Context_Click: 'context-click', Confirm: 'confirm', Reject: 'reject', Long_Press: 'long-press' },
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
    NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

import * as haptics from './haptics';
import * as webHaptics from './haptics.web';
import { getStorage } from '@/sync/domains/state/storageStore';

const originalPlatform = Platform.OS;
const effects = () => [haptics.hapticsDragStart, haptics.hapticsSelection, haptics.hapticsLight,
    haptics.hapticsError, haptics.hapticsSuccess, haptics.hapticsMedium];

beforeEach(() => {
    Reflect.set(Platform, 'OS', 'ios');
    for (const output of Object.values(native)) output.mockClear();
    getStorage().getState().applyLocalSettings({ hapticsEnabled: true });
});
afterEach(() => {
    Reflect.set(Platform, 'OS', originalPlatform);
    getStorage().getState().applyLocalSettings({ hapticsEnabled: true });
    vi.restoreAllMocks();
});

describe('device haptic output', () => {
    it('keeps iOS gesture feedback light and retains success and medium effects', async () => {
        for (const effect of effects()) await effect();
        expect(native.impactAsync.mock.calls).toEqual([['light'], ['light'], ['medium']]);
        expect(native.selectionAsync).toHaveBeenCalledOnce();
        expect(native.notificationAsync.mock.calls).toEqual([['error'], ['success']]);
        expect(native.performAndroidHapticsAsync).not.toHaveBeenCalled();
    });

    it('uses the Android system feedback engine for gesture and instrument feedback', async () => {
        Reflect.set(Platform, 'OS', 'android');
        for (const effect of effects()) await effect();
        expect(native.performAndroidHapticsAsync.mock.calls).toEqual([
            ['drag-start'], ['segment-tick'], ['context-click'], ['reject'], ['confirm'], ['long-press'],
        ]);
        expect(native.impactAsync).not.toHaveBeenCalled();
        expect(native.selectionAsync).not.toHaveBeenCalled();
        expect(native.notificationAsync).not.toHaveBeenCalled();
    });

    it.each(['ios', 'android'] as const)('honors opt-out immediately for every effect on %s', async (os) => {
        Reflect.set(Platform, 'OS', os);
        getStorage().getState().applyLocalSettings({ hapticsEnabled: false });
        for (const effect of effects()) await effect();
        for (const output of Object.values(native)) expect(output).not.toHaveBeenCalled();
        getStorage().getState().applyLocalSettings({ hapticsEnabled: true });
        await haptics.hapticsSelection();
        expect(os === 'ios' ? native.selectionAsync : native.performAndroidHapticsAsync).toHaveBeenCalledOnce();
    });

    it('contains asynchronous and synchronous device failures and makes them observable', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        native.impactAsync.mockRejectedValueOnce(new Error('native unavailable'));
        await expect(haptics.hapticsLight()).resolves.toBeUndefined();
        native.impactAsync.mockImplementationOnce(() => { throw new Error('native synchronous failure'); });
        await expect(haptics.hapticsLight()).resolves.toBeUndefined();
        Reflect.set(Platform, 'OS', 'android');
        native.performAndroidHapticsAsync.mockRejectedValueOnce(new Error('android unavailable'));
        await expect(haptics.hapticsDragStart()).resolves.toBeUndefined();
        expect(warning).toHaveBeenCalledTimes(3);
    });

    it('keeps web, desktop-like hosts and the web twin silent', async () => {
        for (const os of ['web', 'windows', 'macos']) {
            Reflect.set(Platform, 'OS', os);
            for (const effect of effects()) await effect();
        }
        for (const effect of Object.values(webHaptics)) await effect();
        for (const output of Object.values(native)) expect(output).not.toHaveBeenCalled();
    });
});
