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
    it('draws optional access and decision controls at their design size, never at the 48dp target', async () => {
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
        // A touch target is a hit area, not a drawn size (DESIGN.md): no control grows to 48.
        expect(flattenTestStyle(optional?.props.style).minHeight).toBeUndefined();
        for (const testID of [
            'settings.plugins.installReview.cancel',
            'settings.plugins.installReview.confirm',
        ]) {
            const control = screen.findByTestId(testID);
            expect(control).toBeDefined();
            const style = typeof control?.props.style === 'function' ? control.props.style({ pressed: false }) : control?.props.style;
            expect(flattenTestStyle(style).minHeight).toBeUndefined();
        }
    });
});
