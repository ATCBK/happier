import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { getStorage } from '@/sync/domains/state/storageStore';

const { selectionAsync, impactAsync } = vi.hoisted(() => ({
    selectionAsync: vi.fn(() => Promise.resolve()),
    impactAsync: vi.fn(() => Promise.resolve()),
}));

vi.mock('expo-haptics', () => ({
    selectionAsync,
    impactAsync,
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

import { instrumentSelectionTick, instrumentThresholdImpact } from './haptics';

const originalPlatform = Platform.OS;

describe('instrument haptics gating', () => {
    beforeEach(() => {
        Reflect.set(Platform, 'OS', 'ios');
        getStorage().getState().applyLocalSettings({ hapticsEnabled: true });
        selectionAsync.mockClear();
        impactAsync.mockClear();
    });

    afterEach(() => {
        Reflect.set(Platform, 'OS', originalPlatform);
        getStorage().getState().applyLocalSettings({ hapticsEnabled: true });
    });

    it('respects the live device opt-out even if a caller passes true', () => {
        getStorage().getState().applyLocalSettings({ hapticsEnabled: false });
        instrumentSelectionTick(true);
        instrumentThresholdImpact(true);
        expect(selectionAsync).not.toHaveBeenCalled();
        expect(impactAsync).not.toHaveBeenCalled();
        getStorage().getState().applyLocalSettings({ hapticsEnabled: true });
        instrumentSelectionTick(true);
        expect(selectionAsync).toHaveBeenCalledOnce();
    });

    it('keeps web silent even if a caller passes true', () => {
        Reflect.set(Platform, 'OS', 'web');
        instrumentSelectionTick(true);
        instrumentThresholdImpact(true);
        expect(selectionAsync).not.toHaveBeenCalled();
        expect(impactAsync).not.toHaveBeenCalled();
    });

    it('does not fire when disabled', () => {
        instrumentSelectionTick(false);
        instrumentThresholdImpact(false);
        expect(selectionAsync).not.toHaveBeenCalled();
        expect(impactAsync).not.toHaveBeenCalled();
    });

    it('fires a selection tick when enabled (native)', () => {
        instrumentSelectionTick(true);
        expect(selectionAsync).toHaveBeenCalledTimes(1);
        expect(impactAsync).not.toHaveBeenCalled();
    });

    it('fires a medium impact for threshold crossings when enabled', () => {
        instrumentThresholdImpact(true);
        expect(impactAsync).toHaveBeenCalledTimes(1);
        expect(impactAsync).toHaveBeenCalledWith('medium');
    });

    it('swallows rejected haptic promises without throwing', () => {
        selectionAsync.mockImplementationOnce(() => Promise.reject(new Error('no haptics')));
        expect(() => instrumentSelectionTick(true)).not.toThrow();
    });
});
