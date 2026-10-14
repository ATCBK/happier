import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

/** Collection destinations open their pages directly while retaining page-owned search anchors. */
export const SKILLS_SETTINGS = [
    defineSettingsPage({
        pageId: 'skills',
        subpage: { id: 'updates', route: SETTINGS_ROUTES.skillsUpdates, titleKey: 'capabilities.skillsUpdates.updates.title', anchors: 'page' },
        sections: { destinations: { settings: { updates: {} } } },
    }),
    defineSettingsPage({
        pageId: 'skills',
        subpage: { id: 'found', route: SETTINGS_ROUTES.skillsFound, titleKey: 'capabilities.skillsFound.title', anchors: 'page' },
        sections: { destinations: { settings: { found: {} } } },
    }),
    defineSettingsPage({
        pageId: 'skills',
        subpage: { id: 'choose', route: SETTINGS_ROUTES.skillsChoose, titleKey: 'capabilities.skills.home.choose', anchors: 'page' },
        sections: { destinations: { settings: { choose: {} } } },
    }),
] as const;
