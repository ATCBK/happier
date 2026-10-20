import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { useApplyBrandHeroSeen } from './useApplyBrandHeroSeen';
import { useBrandHeroSeenAt } from './useBrandHeroSeenAt';

describe('brand hero local setting hooks', () => {
    it('remembers the current timestamp even with Settings writes Off', async () => {
        const previousState = storage.getState();
        const now = 1_789_123_456_789;
        const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

        try {
            storage.setState((state) => ({
                ...state,
                settings: settingsParse({ actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }),
                localSettings: {
                    ...localSettingsDefaults,
                    brandHeroSeenAt: null,
                },
            }));

            const hook = await renderHook(() => ({
                brandHeroSeenAt: useBrandHeroSeenAt(),
                applyBrandHeroSeen: useApplyBrandHeroSeen(),
            }));

            expect(hook.getCurrent().brandHeroSeenAt).toBeNull();

            await act(async () => {
                hook.getCurrent().applyBrandHeroSeen();
            });

            expect(hook.getCurrent().brandHeroSeenAt).toBe(now);
            expect(storage.getState().localSettings.brandHeroSeenAt).toBe(now);

            await hook.unmount();
        } finally {
            dateNowSpy.mockRestore();
            storage.setState(previousState);
        }
    });
});
