import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';
import { COORDINATION_SETTINGS } from '@/components/settings/coordination/coordinationSettings';
import { SettingAnchor, SettingSection } from '@/components/settings/shell/SettingRow';
import { useSessionAutoFollowPreferences } from './useSessionAutoFollowPreferences';

const FIELDS = ['assigned', 'direct', 'team', 'group'] as const;
const FIELD_SETTINGS = {
    assigned: COORDINATION_SETTINGS.settings.autoFollowAssigned,
    direct: COORDINATION_SETTINGS.settings.autoFollowDirect,
    team: COORDINATION_SETTINGS.settings.autoFollowTeam,
    group: COORDINATION_SETTINGS.settings.autoFollowGroup,
};
type AutoFollowLevel = 'important' | 'off';

/**
 * Follow automatically (Settings → Coordination, lab P5): each default rule is a level — Important follows
 * the matching sessions, Off does not. The Home's four `follow.preferences` switches stay the stored value.
 */
export function SessionAutoFollowPreferencesSection({ serverId }: Readonly<{ serverId: string }>) {
    const { enabled, displayed, online, saving, error, save, retry } = useSessionAutoFollowPreferences(serverId);
    if (!enabled) return null;
    const levels = [
        { id: 'important' as const, label: t('session.follow.policy.important') },
        { id: 'off' as const, label: t('common.off') },
    ];
    return <SettingSection section={COORDINATION_SETTINGS.sectionRefs.autoFollow}>
        <ItemGroup title={t('session.follow.preferences.title')} description={t('session.follow.preferences.help')}>
        {displayed ? FIELDS.map((field) => <SettingAnchor key={field} setting={FIELD_SETTINGS[field]}>
            <SegmentedChoiceItem<AutoFollowLevel>
                testIDPrefix={`session-auto-follow-${field}`}
                title={t(FIELD_SETTINGS[field].titleKey)}
                titleLines={0}
                options={levels}
                value={displayed[field] ? 'important' : 'off'}
                disabled={!online || saving}
                onChange={(level) => { void save({ patch: { [field]: level === 'important' } }); }}
            />
        </SettingAnchor>) : <Item title={t('common.loading')} loading={!error && online} mode="info" />}
        {!online || error ? <Item
            testID="session-auto-follow-error"
            title={!online ? t('session.follow.offline') : t('errors.unknownError')}
            titleLines={0}
            mode="info"
            accessibilityLiveRegion="polite"
        /> : null}
        {online && error ? <Item
            testID="session-auto-follow-retry"
            title={t('common.retry')}
            onPress={retry}
            showChevron={false}
        /> : null}
    </ItemGroup>
    </SettingSection>;
}
