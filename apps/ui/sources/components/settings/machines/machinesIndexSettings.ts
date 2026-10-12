import * as React from 'react';
import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * The searchable setting of the Machines page itself: whether All machines is a List (table) or a Grid
 * (one card per machine), remembered on this device (MPG-11). Declared so search lands on the switch
 * and agents change it through `settings.set { anchor: 'machines.indexView' }`; the page renders its
 * List | Grid control inside this declaration's `SettingAnchor`.
 */
export const MACHINES_INDEX_SETTINGS = defineSettingsPage({
    pageId: 'machines',
    sections: {
        index: {
            titleKey: 'settings.machines',
            settings: {
                indexView: {},
            },
        },
    },
});

export type MachinesIndexView = 'list' | 'grid';

/** The remembered All machines view on this device, and its writer (the same key `settings.set` writes). */
export function useMachinesIndexView(): readonly [MachinesIndexView, (next: MachinesIndexView) => void] {
    const view = useLocalSetting('machinesIndexViewV1');
    const { setSetting } = useSettingActionFeedback();
    const setView = React.useCallback((next: MachinesIndexView) => {
        fireAndForget(setSetting(MACHINES_INDEX_SETTINGS.settings.indexView, next));
    }, [setSetting]);
    return [view, setView] as const;
}
