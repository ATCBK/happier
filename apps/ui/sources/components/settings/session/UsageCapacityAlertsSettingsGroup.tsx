import * as React from 'react';
import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { SESSION_PROVIDER_LIMITS_SETTINGS } from '@/components/settings/session/sessionProviderLimitsSettings';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSetting } from '@/sync/domains/state/storage';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { t } from '@/text';
import { readUsagePersonalPaceTarget } from '@/components/settings/usage/widgets/plans/usagePacingTarget';

const DAY_MS = 24 * 60 * 60 * 1000;
type Toggle = 'pace' | 'depletion' | 'reset' | 'unused';
const TARGET_CHOICES = ['off', '50', '75', '90'] as const;
const LEAD_CHOICES = ['off', String(DAY_MS), String(2 * DAY_MS)] as const;
const REMAINING_CHOICES = ['off', '0.1', '0.25'] as const;
/** A target written elsewhere (an agent, another device) keeps its own value as a choice instead of reading as off. */
const toTarget = (fraction: number | null): string => fraction === null ? 'off' : String(Math.round(fraction * 100));
/** Lead times and remaining thresholds are stored as exact numbers; an unlisted stored value keeps its own segment. */
const toChoice = (value: number | null): string => value === null ? 'off' : String(value);
const fromChoice = (choice: string): number | null => choice === 'off' ? null : Number(choice);
const withStored = (choices: readonly string[], stored: string): string[] => [...new Set<string>([...choices, stored])]
    .sort((a, b) => (a === 'off' ? -1 : b === 'off' ? 1 : Number(a) - Number(b)));
const formatPercent = (fraction: number): number => Math.round(fraction * 1000) / 10;
const formatDays = (ms: number): number => Math.round((ms / DAY_MS) * 10) / 10;

/**
 * The personal pace target (lab `p2budget`, advice only) and capacity alerts (lab `p2alerts` N3): the Account's usage notification choices, written to the one
 * `usageQuotaNotificationsV1` preference the daemon's lifecycle notifier reads. Every alert is off
 * until chosen; thresholds are the viewer's choice, never a default.
 */
export const UsageCapacityAlertsSettingsGroup = React.memo(function UsageCapacityAlertsSettingsGroup() {
    const enabled = useFeatureEnabled('connectedServices.quotas');
    const alerts = useSetting('usageQuotaNotificationsV1');
    const targets = useSetting('usagePacingTargetsV1');
    const { setSetting } = useSettingActionFeedback();
    const target = readUsagePersonalPaceTarget(targets);
    const settings = SESSION_PROVIDER_LIMITS_SETTINGS.settings;
    if (!enabled) return null;
    const toggles: readonly Readonly<{ key: Toggle; setting: (typeof settings)['alertPace']; subtitle: string }>[] = [
        { key: 'pace', setting: settings.alertPace, subtitle: t('usage.board.plans.alertPaceSubtitle') },
        { key: 'depletion', setting: settings.alertDepletion, subtitle: t('usage.board.plans.alertDepletionSubtitle') },
        { key: 'reset', setting: settings.alertReset, subtitle: t('usage.board.plans.alertResetSubtitle') },
        { key: 'unused', setting: settings.alertUnused, subtitle: t('usage.board.plans.alertUnusedSubtitle') },
    ];
    const leadOptions = (stored: number | null) => withStored(LEAD_CHOICES, toChoice(stored)).map((id) => ({
        id, label: id === 'off' ? t('usage.board.plans.alertOff') : t('usage.board.plans.alertDaysBefore', { count: formatDays(Number(id)) }),
    }));
    return (
        <ItemGroup title={t('usage.board.plans.alertsTitle')} description={t('usage.board.plans.alertsDescription')}>
            <SettingAnchor setting={settings.personalPaceTarget}>
                <SegmentedChoiceItem<string>
                    testID="settings-usage-pace-target"
                    testIDPrefix="settings-usage-pace-target"
                    title={t(settings.personalPaceTarget.titleKey)}
                    subtitle={t('usage.board.plans.targetSubtitle')}
                    subtitleLines={0}
                    options={[...new Set<string>([...TARGET_CHOICES, toTarget(target)])].map((id) => ({
                        id, label: id === 'off' ? t('usage.board.plans.alertOff') : t('usage.board.plans.targetPercent', { percent: Number(id) }),
                    }))}
                    value={toTarget(target)}
                    onChange={(choice) => { void setSetting(settings.personalPaceTarget, choice === 'off' ? null : Number(choice) / 100); }}
                />
            </SettingAnchor>
            {toggles.map((toggle) => (
                <SettingRow
                    key={toggle.key}
                    setting={toggle.setting}
                    testID={`settings-usage-alerts-${toggle.key}`}
                    subtitle={toggle.subtitle}
                    rightElement={<Switch testID={`settings-usage-alerts-${toggle.key}-toggle`} value={alerts[toggle.key]}
                        onValueChange={(value) => { void setSetting(toggle.setting, value); }} />}
                    showChevron={false}
                    onPress={() => { void setSetting(toggle.setting, !alerts[toggle.key]); }}
                />
            ))}
            <SettingAnchor setting={settings.alertAlmostOut}>
                <SegmentedChoiceItem<string>
                    testID="settings-usage-alerts-almostOut"
                    testIDPrefix="settings-usage-alerts-almostOut"
                    title={t(settings.alertAlmostOut.titleKey)}
                    options={withStored(REMAINING_CHOICES, toChoice(alerts.almostOutRemainingFraction)).map((id) => ({
                        id, label: id === 'off' ? t('usage.board.plans.alertOff') : t('usage.board.plans.alertPercentLeft', { percent: formatPercent(Number(id)) }),
                    }))}
                    value={toChoice(alerts.almostOutRemainingFraction)}
                    onChange={(choice) => { void setSetting(settings.alertAlmostOut, fromChoice(choice)); }}
                />
            </SettingAnchor>
            <SettingAnchor setting={settings.alertEnding}>
                <SegmentedChoiceItem<string>
                    testID="settings-usage-alerts-ending"
                    testIDPrefix="settings-usage-alerts-ending"
                    title={t(settings.alertEnding.titleKey)}
                    options={leadOptions(alerts.endingBeforeMs)}
                    value={toChoice(alerts.endingBeforeMs)}
                    onChange={(lead) => { void setSetting(settings.alertEnding, fromChoice(lead)); }}
                />
            </SettingAnchor>
            <SettingAnchor setting={settings.alertCreditExpiry}>
                <SegmentedChoiceItem<string>
                    testID="settings-usage-alerts-creditExpiry"
                    testIDPrefix="settings-usage-alerts-creditExpiry"
                    title={t(settings.alertCreditExpiry.titleKey)}
                    options={leadOptions(alerts.creditExpiryBeforeMs)}
                    value={toChoice(alerts.creditExpiryBeforeMs)}
                    onChange={(lead) => { void setSetting(settings.alertCreditExpiry, fromChoice(lead)); }}
                />
            </SettingAnchor>
        </ItemGroup>
    );
});
