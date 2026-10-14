import { agentDefaultPermissionStorage, agentEnabledStorage, agentExecutableSourceStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';
import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/**
 * Search keeps the explicit selected Agent address; it never chooses an Agent for the reader.
 * `defaultModel` has no settings storage: its writer is `providers.defaults.set`.
 */
export const AGENT_SETTINGS = defineSettingsPage({
    pageId: 'agents',
    subpage: { id: 'detail', anchors: 'page', titleKey: 'settingsAgents.detailPage.sessionDefaultsTitle',
        route: context => /^\/(?:\(app\)\/)?settings\/agents\/(?:custom\/)?[^/]+$/.test(context.pathname) ? context.pathname : null },
    sections: {
        defaults: { settings: { defaultPermission: { storage: agentDefaultPermissionStorage }, defaultModel: {}, models: {} } },
        preferences: { settings: { enabled: { storage: agentEnabledStorage }, executableSource: { storage: agentExecutableSourceStorage } } },
    },
});
