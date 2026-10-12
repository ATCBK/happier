import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import { buildSettingHref } from './settingDeclarations';
import { SETTINGS_ROUTES } from './routes';
// Start with the runtime consumer so its declaration import cannot observe a
// half-initialized catalog through the App-shell context's import cycle.
await import('./runtime/useResolvedSettingsPageCatalog');
const { SETTINGS_PAGE_DECLARATIONS } = await import('./settingsPageDeclarations');

describe('Providers settings search', () => {
    it('routes selected detail and Gateway controls through their explicit entity rather than a guessed default', () => {
        for (const [pageId, subpageId, pathname, anchors] of [
            ['providers', 'detail', '/settings/providers/pc_work', ['providers.detail.name', 'providers.detail.visibility']],
            ['providers', 'gateway', '/settings/providers/pc_gateway', ['providers.gateway.slots', 'providers.gateway.placement', 'providers.gateway.helpers']],
            ['agents', 'detail', '/settings/agents/codex', ['agents.defaultPermission', 'agents.enabled', 'agents.executableSource']],
        ] as const) {
            const page = SETTINGS_PAGE_DECLARATIONS.find(candidate => candidate.pageId === pageId && candidate.subpage?.id === subpageId);
            expect(page).toBeDefined();
            for (const anchor of anchors) {
                const setting = Object.values(page!.settings).find(candidate => candidate.anchor === anchor);
                expect(setting, anchor).toBeDefined();
                expect(buildSettingHref(page!.subpage!.route, setting!, { pathname, params: {} })).toBe(`${pathname}?setting=${anchor}`);
                expect(buildSettingHref(page!.subpage!.route, setting!, { pathname: '/settings', params: {} })).toBeNull();
            }
        }
    });
    it('offers collection controls at their declared anchors under the Providers feature owner', () => {
        const page = SETTINGS_PAGE_DECLARATIONS.find(candidate => candidate.pageId === 'providers' && !candidate.subpage);
        expect(page).toBeDefined();
        for (const anchor of ['providers.connections', 'providers.add', 'providers.custom', 'providers.local']) {
            const setting = Object.values(page!.settings).find(candidate => candidate.anchor === anchor);
            expect(setting, anchor).toBeDefined();
            expect(buildSettingHref(SETTINGS_ROUTES.providers, setting!)).toBe(`/settings/providers?setting=${anchor}`);
        }
        expect(page!.settings.local!.featureId).toBe('providers.localDiscovery');
    });
});
