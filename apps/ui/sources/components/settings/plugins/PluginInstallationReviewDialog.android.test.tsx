import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';

import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

// Native controls capture their platform's touch-target floor when imported,
// matching the app's fixed platform. Keep Android separate from the web suite.
installSettingsViewCommonModuleMocks({
    storage: 'real',
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'android' } });
    },
});

describe('PluginInstallationReviewDialog on Android', () => {
    it('keeps optional access and decision controls at least 48dp', async () => {
        const { PluginInstallationReviewDialog } = await import('./PluginInstallationReviewDialog');
        const screen = await renderScreen(
            <PluginInstallationReviewDialog
                review={createPluginInstallationReviewFixture({
                    optionalHostAccess: [{
                        id: 'workspace',
                        capability: 'Workspace files',
                        reason: 'Read the selected workspace.',
                        authorizationClass: 'hostResourceSelection',
                        normalizedScope: { kind: 'workspace' },
                    }],
                })}
                target={{ machine: 'Laptop', server: 'Server A' }}
                onResolve={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        const optional = screen.findByTestId('settings.plugins.installReview.optional.workspace');
        expect(flattenTestStyle(optional?.props.style)).toMatchObject({ minWidth: 48, minHeight: 48 });
        for (const testID of [
            'settings.plugins.installReview.cancel',
            'settings.plugins.installReview.confirm',
        ]) {
            const control = screen.findByTestId(testID);
            expect(flattenTestStyle(control?.props.style({ pressed: false }))).toMatchObject({ minHeight: 48 });
        }
    });
});
