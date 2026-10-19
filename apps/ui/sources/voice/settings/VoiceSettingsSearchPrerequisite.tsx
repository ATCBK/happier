import * as React from 'react';

import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { SETTING_ANCHOR_QUERY_PARAM, settingRendersOnHost, type SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';

type VoiceSettingsSearchPrerequisiteProps = Readonly<{
    settings: readonly (SettingRef | undefined)[];
    reason: string;
    /** Outside an existing sheet, use the same page group as an ordinary setting. */
    group?: boolean;
}>;

/** The row owner calls this only in the branch where its settings cannot render. Returning null at
 * that owner also keeps absent rows out of ItemGroup's divider and corner-position calculation. */
export function useVoiceSettingsSearchPrerequisite(): (props: VoiceSettingsSearchPrerequisiteProps) => React.ReactElement | null {
    const params = useLocalSearchParams();
    const raw = params[SETTING_ANCHOR_QUERY_PARAM];
    const requested = Array.isArray(raw) ? raw[0] : raw;
    return (props: VoiceSettingsSearchPrerequisiteProps) => {
        const setting = props.settings.find((candidate) => candidate?.anchor === requested);
        if (!setting || !settingRendersOnHost(setting)) return null;
        const row = <SettingRow key={setting.anchor} setting={setting} testID="settings.voice.searchPrerequisite"
            subtitle={props.reason} subtitleLines={0} disabled showChevron={false} />;
        return props.group ? <ItemGroup key={setting.anchor}>{row}</ItemGroup> : row;
    };
}
