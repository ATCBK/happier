import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '../prompts/registries/promptRegistriesScreenTestHelpers';

installPromptRegistriesCommonModuleMocks({ storage: original => original() });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');

describe('PluginMarketplaceSourcesScreen Account data path', () => {
    it.each(['updated', 'conflict'] as const)('reads and toggles a source without a Machine and keeps the durable Account answer: %s', async outcome => {
        const fixture = await createPlainPromptLibraryCatalogHomeFixture(`https://plugin-source-screen-${outcome}.test`, {
            key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{ id: 'user-source', title: 'Private catalog',
                format: 'happier-catalog', kinds: ['plugin'], url: 'https://catalog.test/index.json', enabled: true, addedAt: 1,
                token: { secretRef: 'catalog-token' } }] },
        }, outcome);
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        const { PluginMarketplaceSourcesScreen } = await import('./PluginMarketplaceSourcesScreen');
        const screen = await renderScreen(<PluginMarketplaceSourcesScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('settings.plugins.sources.enabled.user-source')).not.toBeNull());
        const toggle = screen.findAll(node => node.props.testID === 'settings.plugins.sources.enabled.user-source'
            && typeof node.props.onValueChange === 'function')[0];
        if (!toggle) throw new Error('Missing source toggle');
        expect(toggle.props.disabled).toBe(false);
        await act(async () => { toggle.props.onValueChange(false); });
        await vi.waitFor(() => expect(fixture.mutations).toEqual([{ key: 'registry-sources', expectedRevision: 4 }]));
        expect(fixture.read().record.value).toMatchObject({ sources: [{ id: 'user-source', enabled: outcome !== 'updated',
            token: { secretRef: 'catalog-token' } }] });
        expect(fixture.settingsWrites()).toBe(0);
        expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    });
});
