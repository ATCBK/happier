import { describe, expect, it } from 'vitest';

import { buildSettingHref, defineSettingsPage } from './settingDeclarations';
import { SESSION_SETTINGS } from '@/components/settings/session/sessionSettings';
import { SOURCE_CONTROL_SETTINGS } from '@/components/settings/sourceControl/sourceControlSettings';

describe('scoped setting links', () => {
    it('keeps Track’s canonical settings Action anchor when its row lives on the source-control page', () => {
        const ref = SOURCE_CONTROL_SETTINGS.settings.trackAgentEdits;
        expect(ref).toMatchObject({ anchor: 'files.trackAgentEdits', sectionId: 'sourceControl.files',
            storage: { scope: 'local', key: 'filesTrackAgentEdits', access: 'read_write' } });
        expect(buildSettingHref('/settings/source-control', ref)).toBe('/settings/source-control?setting=files.trackAgentEdits');
        expect(() => defineSettingsPage({ pageId: 'sourceControl', sections: { files: { settings: {
            one: { anchor: 'files.trackAgentEdits' }, two: { anchor: 'files.trackAgentEdits' },
        } } } })).toThrow('Duplicate setting anchor');
    });
    it('projects the MCP failure policy from its Sessions declaration and links to that page', () => {
        const setting = SESSION_SETTINGS.settings.mcpServersStrictMode;
        expect(setting).toMatchObject({ anchor: 'session.mcpServersStrictMode',
            storage: { scope: 'account', key: 'mcpServersStrictMode', access: 'read_write' } });
        expect(SESSION_SETTINGS.sectionRefs.mcpServersReliability.id).toBe('session.mcpServersReliability');
        expect(buildSettingHref('/settings/session', setting)).toBe('/settings/session?setting=session.mcpServersStrictMode');
    });
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
