import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/settings/connectedServices/ConnectedServicesProviderStateSharingSettings', () => ({
    ConnectedServicesProviderStateSharingSettingsView: () =>
        React.createElement('ConnectedServicesProviderStateSharingSettingsView'),
}));

installSessionSettingsEntryModuleMocks();

describe('Connected services provider-state-sharing route', () => {
    afterEach(async () => {
        await standardCleanup();
        vi.restoreAllMocks();
        resetSessionSettingsEntryState();
    });

    it('renders without consulting the retired connectedServices master feature', async () => {
        // Observe the real reader without replacing its policy. This retired
        // master id must not become a dependency of this unconditionally hosted route.
        const featureReader = await import('@/hooks/server/useFeatureEnabled');
        const useFeatureEnabledMock = vi.spyOn(featureReader, 'useFeatureEnabled');

        const mod = await import('@/app/(app)/settings/connected-services/provider-state-sharing');
        const ProviderStateSharingRoute = mod.default;

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(ProviderStateSharingRoute))).tree;

        expect(tree.toJSON()).not.toBeNull();
        expect(useFeatureEnabledMock).not.toHaveBeenCalled();
        expect(tree.findByType('ConnectedServicesProviderStateSharingSettingsView' as any)).toBeTruthy();
    });
});
