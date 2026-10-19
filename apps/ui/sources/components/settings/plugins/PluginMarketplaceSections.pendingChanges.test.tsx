import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks();
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());

describe('Pending plugin changes', () => {
    afterEach(standardCleanup);

    it('uses local flight only to suppress interaction while preserving daemon review state', async () => {
        const { PendingPluginChangesSection } = await import('./PluginMarketplaceSections');
        const pendingChangeId = 'pending-install-1';
        const view = (busy: boolean) => <PendingPluginChangesSection
            pendingChanges={[{
                kind: 'projectTrust',
                projectTrustReview: {
                    pendingChangeId,
                    review: { source: { kind: 'path', locator: '/workspace/leads-fixture' } },
                },
            }]}
            canRunActions
            isPluginActionInFlight={(id) => busy && id === pendingChangeId}
            onDecide={() => {}}
        />;
        const screen = await renderScreen(view(true));

        // Opening or cancelling confirmation must not fabricate daemon apply state.
        expect(screen.getTextContent()).toContain('settingsPlugins.developmentTrustProjectSourceTitle');
        expect(screen.getTextContent()).toContain('/workspace/leads-fixture');
        expect(screen.getTextContent()).not.toContain('settingsPlugins.pendingChangeApplying');
        expect(screen.getTextContent()).not.toContain(pendingChangeId);
        expect(screen.findByTestId(`settings.plugins.management.pendingChanges.${pendingChangeId}.action.review`)).not.toBeNull();
        expect(screen.findByTestId(`settings.plugins.management.pendingChanges.${pendingChangeId}.action.reject`)).not.toBeNull();

        await screen.update(view(false));
        expect(screen.getTextContent()).toContain('/workspace/leads-fixture');
        expect(screen.findByTestId(`settings.plugins.management.pendingChanges.${pendingChangeId}.action.review`)).not.toBeNull();
        expect(screen.findByTestId(`settings.plugins.management.pendingChanges.${pendingChangeId}.action.reject`)).not.toBeNull();
    });

    it('shows applying only when the daemon listing owns that state', async () => {
        const { PendingPluginChangesSection } = await import('./PluginMarketplaceSections');
        const pendingChangeId = 'pending-applying-1';
        const screen = await renderScreen(<PendingPluginChangesSection
            pendingChanges={[{ kind: 'applying', pendingChangeId }]}
            canRunActions
            isPluginActionInFlight={() => false}
            onDecide={() => {}}
        />);

        expect(screen.getTextContent()).toContain('settingsPlugins.pendingChangeApplying');
        expect(screen.getTextContent()).not.toContain(pendingChangeId);
        expect(screen.findByTestId(`settings.plugins.management.pendingChanges.${pendingChangeId}.action.review`)).toBeNull();
        expect(screen.findByTestId(`settings.plugins.management.pendingChanges.${pendingChangeId}.action.reject`)).toBeNull();
    });
});
