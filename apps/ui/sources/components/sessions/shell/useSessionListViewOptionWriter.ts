import * as React from 'react';

import { SESSION_SETTINGS } from '@/components/settings/session/sessionSettings';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';

const choiceSettings = new Map<string, SettingRef>([
    ['layout', SESSION_SETTINGS.settings.layout],
    ['attention', SESSION_SETTINGS.settings.attentionPromotion],
    ['working', SESSION_SETTINGS.settings.workingPlacement],
    ['ordering', SESSION_SETTINGS.settings.ordering],
    ['folderDisplay', SESSION_SETTINGS.settings.folderView],
    ['folderSort', SESSION_SETTINGS.settings.folderSort],
    ['grouping:active', SESSION_SETTINGS.settings.activeGrouping],
    ['grouping:inactive', SESSION_SETTINGS.settings.inactiveGrouping],
]);

/** The list menu and Settings submit the same declared choice; its owner rebases coupled fields. */
export function useSessionListViewOptionWriter() {
    const { setSetting } = useSettingActionFeedback();
    return React.useCallback((itemId: string): Promise<boolean> => {
        const separator = itemId.lastIndexOf(':');
        const setting = choiceSettings.get(itemId.slice(0, separator));
        return setting ? setSetting(setting, itemId.slice(separator + 1)) : Promise.resolve(false);
    }, [setSetting]);
}
