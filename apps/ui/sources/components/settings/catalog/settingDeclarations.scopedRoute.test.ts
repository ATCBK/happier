import { describe, expect, it } from 'vitest';

import { buildSettingHref, defineSettingsPage } from './settingDeclarations';

describe('scoped setting links', () => {
    it('uses explicit route context and omits a setting when its destination is unavailable', () => {
        const ref = { anchor: 'teams.oidc.issuer' };
        const route = (context: Readonly<{ pathname: string; params: Readonly<Record<string, string | string[] | undefined>> }>) => (
            context.pathname === '/settings/teams/home-b/team-one/authentication/connection-one/edit'
            && context.params.providerId === 'provider-one'
                ? `${context.pathname}?providerId=provider-one`
                : null
        );
        const context = {
            pathname: '/settings/teams/home-b/team-one/authentication/connection-one/edit',
            params: { providerId: 'provider-one' },
        };

        expect(buildSettingHref(route, ref, context)).toBe(`${context.pathname}?providerId=provider-one&setting=teams.oidc.issuer`);
        expect(buildSettingHref(route, ref, { ...context, pathname: '/settings' })).toBeNull();
        expect(buildSettingHref(route, ref)).toBeNull();
        expect(buildSettingHref('/settings/session?mode=resume', ref)).toBe('/settings/session?mode=resume&setting=teams.oidc.issuer');
    });
});

describe('a sub-page that keeps its catalog page anchors', () => {
    it('keeps the shared ids of rows that moved to a sub-page route', () => {
        const moved = defineSettingsPage({
            pageId: 'appearance',
            subpage: { id: 'motion', route: '/settings/appearance/motion', titleKey: 'settingsAppearance.visualEffects.title', anchors: 'page' },
            sections: { loadingIndicator: { settings: { loadingIndicatorStyle: {} } } },
        });

        expect(moved.settings.loadingIndicatorStyle.anchor).toBe('appearance.loadingIndicatorStyle');
        expect(moved.sectionRefs.loadingIndicator.id).toBe('appearance.loadingIndicator');
        expect(buildSettingHref(moved.subpage!.route, moved.settings.loadingIndicatorStyle))
            .toBe('/settings/appearance/motion?setting=appearance.loadingIndicatorStyle');
    });
});
