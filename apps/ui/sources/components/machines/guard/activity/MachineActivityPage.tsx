import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierDataMetric, HappierPressable, HappierSkeletonBlock, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { MachineGuardActivityListV1 } from '@happier-dev/protocol/machines/guard/activityV1';

import { useMachineTabCompactLayout } from '@/components/machines/page/useMachineTabCompactLayout';
import { PolicyValueSelect } from '@/components/machines/policy/PolicyValueSelect';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { MachineGuardActivityQuery } from '@/sync/domains/machines/guard/machineGuardRpc';
import { useMachineGuardActivity } from '@/sync/domains/machines/guard/useMachineGuardView';
import { getPreferredLanguage, t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import { MachineFreshnessChip } from '@/components/machines/page/MachineFreshnessChip';
import { useGuardActivityFreshness } from '../useGuardFreshness';
import { groupGuardActivityByDay } from './guardActivityPresentation';
import { MachineActivityRow } from './MachineActivityRow';
import { useGuardWayBack } from './useGuardWayBack';

type Filter = MachineGuardActivityQuery['filter'];
type Range = MachineGuardActivityQuery['range'];
const FILTERS: readonly Filter[] = ['all', 'stopped', 'cleaned_up', 'needs_look'];
const RANGES: readonly Range[] = ['today', '7d', '30d'];
const LONGER: Readonly<Record<Range, Range | null>> = { today: '7d', '7d': '30d', '30d': null };

/**
 * Everything Happier did on the machine by itself (lab `rg` G7 / G7p / G7s): what it freed, what sits
 * in Trash and what needs a look; filters with their counts and a range; the receipts by day, each with
 * its way back. Receipts are the daemon's (kept 30 days); a shared machine's recipient sees their own
 * and only a count of other people's.
 */
export const MachineActivityPage = React.memo(function MachineActivityPage(props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    onBack: () => void;
    barAccessoryShown: boolean;
}>) {
    const language = usePreferredLanguage();
    const [filter, setFilter] = React.useState<Filter>('all');
    const [range, setRange] = React.useState<Range>('7d');
    const layout = useMachineTabCompactLayout();
    // The summary and the filter counts always describe the whole range; the list follows the filter.
    const all = useMachineGuardActivity({ machineId: props.machineId, serverId: props.serverId, range, filter: 'all' });
    const filtered = useMachineGuardActivity({ machineId: props.machineId, serverId: props.serverId, range, filter });
    const wayBack = useGuardWayBack({ serverId: props.serverId, machineId: props.machineId });
    const selected = filter === 'all' ? all : filtered;
    const { list, status } = selected;
    const freshness = useGuardActivityFreshness(selected);
    const groups = React.useMemo(() => list ? groupGuardActivityByDay(list.entries) : [], [language, list]);
    const counts = all.list?.counts ?? null;
    const total = counts ? counts.stopped + counts.cleanedUp + counts.needsLook : null;
    const filterCount = (id: Filter) => !counts ? null : id === 'all' ? total : id === 'stopped' ? counts.stopped : id === 'cleaned_up' ? counts.cleanedUp : counts.needsLook;

    return (
        <View testID="machine-activity-page" onLayout={layout.onLayout}>
            <ItemGroup surface="none" header="none">
                <View style={styles.titleBlock}>
                    <View style={styles.titleRow}>
                        <BackLink onPress={props.onBack} />
                        <Text accessibilityRole="header" style={styles.title}>{t('machineGuard.activity.title')}</Text>
                        {layout.compact ? null : <Text style={styles.accessory}>{t('machineGuard.activity.pageAccessory', { machine: props.machineName })}</Text>}
                    </View>
                    <MachineFreshnessChip testID={`machine-activity-${freshness.kind}`} freshness={freshness} />
                </View>
            </ItemGroup>
            {all.list ? <ActivitySummary list={all.list} /> : null}
            <ItemGroup surface="none" header="none">
                <View style={[styles.controls, layout.compact ? styles.controlsCompact : null]}>
                    {layout.compact ? (
                        <PolicyValueSelect testID="machine-activity-filter" label={t('machineGuard.activity.filters.label')}
                            value={t(`machineGuard.activity.filters.${filter}`)} selectedId={filter}
                            choices={FILTERS.map(id => ({ id, title: `${t(`machineGuard.activity.filters.${id}`)}${filterCount(id) === null ? '' : ` · ${filterCount(id)}`}` }))}
                            onSelect={id => setFilter(id as Filter)} />
                    ) : (
                        <SegmentedTabBar<Filter> role="radiogroup" targetSize="platform" segmentSizing="content"
                            accessibilityLabel={t('machineGuard.activity.filters.label')} testIDPrefix="machine-activity-filter"
                            tabs={FILTERS.map(id => { const count = filterCount(id); return { id, label: t(`machineGuard.activity.filters.${id}`), ...(count === null ? {} : { count: count.toLocaleString(getPreferredLanguage()) }) }; })}
                            activeTabId={filter} onSelectTab={setFilter} />
                    )}
                    <PolicyValueSelect testID="machine-activity-range" label={t('machineGuard.activity.ranges.label')}
                        value={t(`machineGuard.activity.ranges.${range}`)} selectedId={range}
                        choices={RANGES.map(id => ({ id, title: t(`machineGuard.activity.ranges.${id}`) }))}
                        onSelect={id => setRange(id as Range)} />
                </View>
            </ItemGroup>
            {!list ? (
                status === 'error' || status === 'not_reported' ? (
                    <ItemGroup>
                        <SurfaceStateCard testID="machine-activity-error" kind="error" size="line" title={t('machineGuard.activity.error')}
                            action={selected.offline ? undefined : { label: t('machineGuard.tryAgain'), onPress: selected.retry }} />
                    </ItemGroup>
                ) : all.offline ? (
                    <ItemGroup>
                        <SurfaceStateCard testID="machine-activity-offline" kind="unavailable" size="line"
                            title={t('machineGuard.states.offlineEmpty', { machine: props.machineName })} />
                    </ItemGroup>
                ) : <ActivityLoading />
            ) : groups.length === 0 ? (
                <ItemGroup>
                    <SurfaceStateCard testID="machine-activity-empty" kind="empty" size="line" iconName="clock"
                        title={filter === 'all' && total === 0 ? t('machineGuard.activity.empty', { machine: props.machineName }) : t('machineGuard.activity.noMatches')} />
                </ItemGroup>
            ) : groups.map(group => (
                <ItemGroup key={group.dayStart} title={formatActivityDay(group.dayStart)}
                    titleAccessory={<Text style={styles.dayAccessory}>{[
                        ...(group.freedMemoryBytes > 0 ? [t('machineGuard.activity.dayFreed', { amount: formatMachineBytes(group.freedMemoryBytes, 'memory') })] : []),
                        ...(group.inTrashBytes > 0 ? [t('machineGuard.activity.dayInTrash', { amount: formatMachineBytes(group.inTrashBytes, 'storage') })] : []),
                    ].join(' · ')}</Text>}>
                    {group.entries.map((entry, index) => (
                        <MachineActivityRow key={entry.id} entry={entry} pendingId={wayBack.pendingId} onWayBack={wayBack.run}
                            readOnly={all.offline} showDivider={index < group.entries.length - 1} />
                    ))}
                </ItemGroup>
            ))}
            {list ? (
                <ItemGroup surface="none" header="none">
                    <View style={styles.footer}>
                        {LONGER[range] ? <TextLinkButton testID="machine-activity-earlier" tone="strong" label={t('machineGuard.activity.showEarlier')}
                            onPress={() => setRange(LONGER[range]!)} /> : null}
                        <Text style={styles.footerText}>{t('machineGuard.activity.keptFor', { machine: props.machineName })}</Text>
                    </View>
                    {list.counts.others > 0 ? <Text style={styles.footerText}>{t('machineGuard.activity.others', { count: list.counts.others })}</Text> : null}
                </ItemGroup>
            ) : null}
        </View>
    );
});

/** "Today", "Yesterday", "Monday, October 6". */
function formatActivityDay(dayStart: number): string {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const delta = Math.round((today.getTime() - dayStart) / 86_400_000);
    if (delta === 0) return t('machineGuard.activity.today');
    if (delta === 1) return t('machineGuard.activity.yesterday');
    return new Intl.DateTimeFormat(getPreferredLanguage(), { weekday: 'long', month: 'long', day: 'numeric' }).format(dayStart);
}

/** Memory freed · In Trash · Needs a look, over the whole range (plan 10's stat tiles). */
function ActivitySummary(props: Readonly<{ list: MachineGuardActivityListV1 }>) {
    const { theme } = useUnistyles();
    const pluginTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const live = props.list.entries.filter(entry => entry.undoneAt === undefined);
    const freed = live.reduce((sum, entry) => sum + (entry.kind !== 'trash_emptied' ? entry.freedBytes ?? 0 : 0), 0);
    const inTrash = live.filter(entry => entry.kind === 'trash_moved').reduce((sum, entry) => sum + (entry.inTrashBytes ?? 0), 0);
    const trashItems = live.filter(entry => entry.kind === 'trash_moved').reduce((sum, entry) => sum + (entry.subject?.kind === 'trash' ? entry.subject.items : 0), 0);
    const freedParts = formatMachineBytes(freed, 'memory');
    const trashParts = formatMachineBytes(inTrash, 'storage');
    return (
        <ItemGroup>
            <View style={styles.tiles} testID="machine-activity-summary">
                <View style={styles.tile}>
                    <HappierDataMetric theme={pluginTheme} size="stat" label={t('machineGuard.activity.tiles.memoryFreed')} value={freedParts}
                        caption={t('machineGuard.activity.tiles.stops', { count: props.list.counts.stopped })} />
                </View>
                <View style={[styles.tile, styles.tileDivider]}>
                    <HappierDataMetric theme={pluginTheme} size="stat" label={t('machineGuard.activity.tiles.inTrash')} value={trashParts}
                        caption={trashItems > 0 ? t('machineGuard.activity.kinds.trashMoved', { count: trashItems }) : undefined} />
                </View>
                <View style={[styles.tile, styles.tileDivider]}>
                    <HappierDataMetric theme={pluginTheme} size="stat" label={t('machineGuard.activity.tiles.needsLook')}
                        value={String(props.list.counts.needsLook)}
                        caption={props.list.counts.needsLook === 0 ? t('machineGuard.activity.tiles.needsLookNone') : undefined} />
                </View>
            </View>
        </ItemGroup>
    );
}

function BackLink(props: Readonly<{ onPress: () => void }>) {
    const { theme } = useUnistyles();
    return (
        <HappierPressable testID="machine-activity-back" accessibilityRole="link" accessibilityLabel={t('machineGuard.activity.back')}
            onPress={props.onPress} style={styles.back}>
            {(state) => (
                <>
                    <Icon name="caret-left" size={14} color={state.hovered ? theme.colors.text.primary : theme.colors.text.secondary} />
                    <Text style={[styles.backText, state.hovered ? { color: theme.colors.text.primary } : null]}>{t('machineGuard.activity.back')}</Text>
                </>
            )}
        </HappierPressable>
    );
}

function ActivityLoading() {
    const { theme } = useUnistyles();
    const color = theme.colors.border.default;
    return (
        <ItemGroup>
            <View testID="machine-activity-loading" accessibilityLabel={t('machineGuard.activity.loading')} accessibilityRole="progressbar">
                {Array.from({ length: 4 }, (_, index) => (
                    <View key={index} style={styles.skeletonRow}>
                        <HappierSkeletonBlock color={color} width="44%" height={14} />
                        <HappierSkeletonBlock color={color} width="30%" height={12} />
                    </View>
                ))}
            </View>
        </ItemGroup>
    );
}

const styles = StyleSheet.create((theme) => ({
    titleBlock: {
        gap: theme.space.s8,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'baseline',
        flexWrap: 'wrap',
        columnGap: 14,
        rowGap: theme.space.s4,
    },
    back: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s2,
        minHeight: 28,
    },
    backText: {
        ...Typography.default('medium'),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
    },
    title: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('pageTitle'),
        color: theme.colors.text.primary,
    },
    accessory: {
        ...Typography.default(),
        ...happierPageTextMetrics('pageDescription'),
        color: theme.colors.text.secondary,
    },
    tiles: {
        flexDirection: 'row',
        flexWrap: 'wrap',
    },
    tile: {
        flexGrow: 1,
        flexBasis: 180,
        paddingHorizontal: theme.space.s16,
        paddingVertical: 14,
    },
    tileDivider: {
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.border.subtle,
    },
    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s12,
    },
    controlsCompact: {
        justifyContent: 'flex-start',
    },
    dayAccessory: {
        ...Typography.default(),
        ...happierPageTextMetrics('sectionDescription'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        flexWrap: 'wrap',
    },
    footerText: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
    },
    skeletonRow: {
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s16,
        paddingVertical: 14,
    },
}));
