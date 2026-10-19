import * as React from 'react';
import { ExchangeCheckInBannerPreview } from '@/components/sessions/pending/ExchangeCheckInBanner';
import { View, type ScrollView } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { COORDINATOR_KEEP_DEFAULT_VALUES, type CoordinatorKeepDefault } from '@happier-dev/protocol/account/settings/accountSettings';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { showOnlyCoordinatorsInSessionList } from '@/components/sessions/shell/search/useSessionListViewFilters';
import { useRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
import { useRoleMark } from '@/components/roles/catalog/useRoleMark';
import { SettingAnchor, SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { useSessionAutoFollowPreferences } from '@/components/sessions/follow/useSessionAutoFollowPreferences';
import { SessionAutoFollowPreferencesSection } from '@/components/sessions/follow/SessionAutoFollowPreferencesSection';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { parseCheckInTurns, withNeverPause } from './coordinationCheckIn';
import { COORDINATION_SETTINGS } from './coordinationSettings';
import { CoordinatorKeepListPreview, CoordinatorKeepRailPreview } from './CoordinatorKeepPreviews';

const SETTINGS = COORDINATION_SETTINGS.settings;
const DEFAULT_CHECK_IN_TURNS = settingsDefaults.coordinationAutonomousCheckIn.afterTurns ?? 1;

type FixedKeep = Exclude<CoordinatorKeepDefault, 'suggest'>;
const FIXED_KEEP_VALUES = COORDINATOR_KEEP_DEFAULT_VALUES.filter((value): value is FixedKeep => value !== 'suggest');
const FIXED_KEEP_TITLES = {
    rail_bot: 'settingsCoordination.keepRail',
    list_pin: 'settingsCoordination.keepList',
    none: 'settingsCoordination.keepNone',
} as const satisfies Record<FixedKeep, string>;

export const CoordinationSettingsView = React.memo(function CoordinationSettingsView() {
    const popoverBoundaryRef = React.useRef<ScrollView>(null);
    return (
        <ItemList ref={popoverBoundaryRef} style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsCoordination.pageDescription')} />
            <ShowCoordinatorsGroup />
            <NewCoordinatorsGroup popoverBoundaryRef={popoverBoundaryRef} />
            <DefaultLevelsGroup popoverBoundaryRef={popoverBoundaryRef} />
            <FollowAutomaticallyGroup />
            <CheckInGroup />
        </ItemList>
    );
});

/** The page's one link: opens the session list narrowed to coordinators. */
function ShowCoordinatorsGroup() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const showCoordinators = React.useCallback(() => {
        showOnlyCoordinatorsInSessionList();
        router.navigate('/');
    }, [router]);
    return (
        <ItemGroup>
            <Item
                testID="settings-coordination-show-coordinators"
                icon={<Icon name="tree-structure" size={20} color={theme.colors.text.secondary} />}
                title={t('settingsCoordination.showCoordinators')}
                subtitle={t('settingsCoordination.showCoordinatorsDescription')}
                subtitleLines={0}
                showChevron
                onPress={showCoordinators}
            />
        </ItemGroup>
    );
}

function NewCoordinatorsGroup(props: Readonly<{ popoverBoundaryRef: React.RefObject<ScrollView | null> }>) {
    const [keep, setKeep] = useSettingMutable('coordinationCoordinatorKeep');
    const [suggestProjectRule, setSuggestProjectRule] = useSettingMutable('coordinationCoordinatorSuggestProjectRule');
    const [suggestHomeRule, setSuggestHomeRule] = useSettingMutable('coordinationCoordinatorSuggestHomeRule');
    const [answersWorkerQuestions, setAnswersWorkerQuestions] = useSettingMutable('coordinationCoordinatorAnswersWorkerQuestions');
    const fixedKeep = keep === 'suggest' ? null : keep;
    return (
        <SettingSection section={COORDINATION_SETTINGS.sectionRefs.newCoordinatorDefaults}>
            <ItemGroup
                title={t(SETTINGS.newCoordinatorRole.sectionTitleKey ?? 'settingsCoordination.newCoordinatorDefaults')}
                description={t('settingsCoordination.newCoordinatorsDescription')}
            >
                <RoleRow popoverBoundaryRef={props.popoverBoundaryRef} />
                <SettingAnchor setting={SETTINGS.newCoordinatorKeep}>
                    <Item
                        testID="settings-coordination-keep"
                        title={t(SETTINGS.newCoordinatorKeep.titleKey)}
                        subtitle={t('settingsCoordination.keepDescription')}
                        subtitleLines={0}
                        accessoryLayout="stacked"
                        showChevron={false}
                        rightElement={<View style={styles.keepControls}>
                            <SelectionTiles
                                variant="card"
                                accessibilityLabel={t(SETTINGS.newCoordinatorKeep.titleKey)}
                                testIdPrefix="settings-coordination-keep-suggest"
                                maximumColumns={1}
                                value={keep === 'suggest' ? 'suggest' : null}
                                onChange={(next) => { if (next) setKeep('suggest'); }}
                                options={[{
                                    id: 'suggest',
                                    icon: 'sparkle',
                                    title: t('settingsCoordination.keepSuggest'),
                                    subtitle: t('settingsCoordination.keepSuggestDescription'),
                                }]}
                            />
                            <Text variant="meta" style={styles.keepCaption}>{t('settingsCoordination.keepAlways')}</Text>
                            <SelectionTiles
                                variant="visual"
                                accessibilityLabel={t('settingsCoordination.keepAlways')}
                                testIdPrefix="settings-coordination-keep"
                                value={fixedKeep}
                                onChange={(next) => { if (next) setKeep(next); }}
                                options={FIXED_KEEP_VALUES.map((value) => ({
                                    id: value,
                                    title: t(FIXED_KEEP_TITLES[value]),
                                    preview: value === 'rail_bot'
                                        ? <CoordinatorKeepRailPreview />
                                        : <CoordinatorKeepListPreview pinned={value === 'list_pin'} />,
                                }))}
                            />
                        </View>}
                    />
                </SettingAnchor>
                <SettingRow
                    testID="settings-coordination-suggest-project-rule"
                    setting={SETTINGS.suggestProjectRule}
                    subtitle={t('settingsCoordination.suggestProjectRuleDescription')}
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={<Switch
                        accessibilityLabel={t(SETTINGS.suggestProjectRule.titleKey)}
                        value={suggestProjectRule}
                        onValueChange={setSuggestProjectRule}
                    />}
                />
                <SettingRow
                    testID="settings-coordination-suggest-home-rule"
                    setting={SETTINGS.suggestHomeRule}
                    subtitle={t('settingsCoordination.suggestHomeRuleDescription')}
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={<Switch
                        accessibilityLabel={t(SETTINGS.suggestHomeRule.titleKey)}
                        value={suggestHomeRule}
                        onValueChange={setSuggestHomeRule}
                    />}
                />
                <SettingRow
                    testID="settings-coordination-answers-worker-questions"
                    setting={SETTINGS.newCoordinatorAnswersWorkerQuestions}
                    subtitle={t('settingsCoordination.answersWorkerQuestionsDescription')}
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={<Switch
                        accessibilityLabel={t(SETTINGS.newCoordinatorAnswersWorkerQuestions.titleKey)}
                        value={answersWorkerQuestions}
                        onValueChange={setAnswersWorkerQuestions}
                    />}
                />
            </ItemGroup>
        </SettingSection>
    );
}

/** The role a new coordinator starts with, chosen from the same Role catalog every role picker reads. */
function RoleRow(props: Readonly<{ popoverBoundaryRef: React.RefObject<ScrollView | null> }>) {
    const [roleId, setRoleId] = useSettingMutable('coordinationCoordinatorRoleId');
    const [open, setOpen] = React.useState(false);
    const catalog = useRoleCatalog();
    const mark = useRoleMark();
    const choices = catalog.entries.filter((entry) => entry.role.enabled || entry.roleId === roleId);
    const selected = choices.find((entry) => entry.roleId === roleId);
    const items: DropdownMenuItem[] = [
        ...choices.map((entry) => ({ id: entry.roleId, title: entry.role.name, icon: mark(entry.role, 20, entry.roleId) })),
        ...(catalog.status === 'loading' ? [{ id: 'status', title: t('common.loading'), disabled: true }] : []),
        ...(catalog.status === 'failed' ? [{ id: 'status', title: t('roles.settings.loadFailed'), disabled: true }, { id: 'retry', title: t('common.retry') }] : []),
    ];
    return (
        <SettingAnchor setting={SETTINGS.newCoordinatorRole}>
            <DropdownMenu
                testID="settings-coordination-role"
                open={open}
                onOpenChange={setOpen}
                variant="selectable"
                search={false}
                selectedId={selected ? roleId : null}
                showCategoryTitles={false}
                matchTriggerWidth={true}
                connectToTrigger={true}
                rowKind="item"
                popoverBoundaryRef={props.popoverBoundaryRef}
                itemTrigger={{
                    title: t(SETTINGS.newCoordinatorRole.titleKey),
                    subtitle: t('settingsCoordination.roleDescription'),
                    showSelectedSubtitle: false,
                    detailFormatter: () => selected?.role.name ?? (catalog.status === 'ready' ? t('common.unavailable') : t('common.loading')),
                    field: selected ? { leading: mark(selected.role, 16, selected.roleId) } : undefined,
                    itemProps: { subtitleLines: 0 },
                }}
                items={items}
                onSelect={(id) => {
                    if (id === 'retry') { catalog.refresh(); return; }
                    if (id === 'status') return;
                    setRoleId(id);
                    setOpen(false);
                }}
            />
        </SettingAnchor>
    );
}

type CreationLevelField = 'managerPolicy' | 'runReportPolicy' | 'discussionReceivePolicy';
const LEVEL_ROWS = [
    { field: 'managerPolicy', title: 'settingsCoordination.levelUnderLead', subtitle: 'settingsCoordination.levelUnderLeadDescription' },
    { field: 'runReportPolicy', title: 'settingsCoordination.levelRunReport', subtitle: 'settingsCoordination.levelRunReportDescription' },
    { field: 'discussionReceivePolicy', title: 'settingsCoordination.levelDiscussion', subtitle: 'settingsCoordination.levelDiscussionDescription' },
] as const satisfies readonly Readonly<{ field: CreationLevelField; title: string; subtitle: string }>[];
const LEVEL_HINTS = {
    everything: 'settingsCoordination.levelEverythingHint',
    important: 'settingsCoordination.levelImportantHint',
    quiet: 'settingsCoordination.levelQuietHint',
} as const;
type LevelPreset = keyof typeof LEVEL_HINTS;
const LEVEL_PRESETS = Object.keys(LEVEL_HINTS) as readonly LevelPreset[];

/**
 * The levels a follow starts with. They live in the Home's Follow preferences (`follow.preferences.get/set`),
 * the same payload and retry owner as the relationship defaults on Notifications; without the Home's answer
 * the group says so (loading, offline, failed) rather than showing a level it has not read.
 */
function DefaultLevelsGroup(props: Readonly<{ popoverBoundaryRef: React.RefObject<ScrollView | null> }>) {
    const activeServer = useActiveServerSnapshot();
    const { enabled, displayed, online, saving, error, save, retry } = useSessionAutoFollowPreferences(activeServer.serverId);
    const [openField, setOpenField] = React.useState<CreationLevelField | null>(null);
    if (!enabled) return null;
    return (
        <ItemGroup title={t('settingsCoordination.defaultLevelsTitle')} description={t('settingsCoordination.defaultLevelsDescription')}>
            {displayed ? LEVEL_ROWS.map((row) => {
                const policy: FollowPolicyV1 = displayed[row.field] ?? DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1[row.field];
                const items: DropdownMenuItem[] = [
                    ...LEVEL_PRESETS.map((preset) => ({
                        id: preset,
                        title: t(`session.follow.policy.${preset}`),
                        subtitle: t(LEVEL_HINTS[preset]),
                    })),
                    ...(policy.preset === 'custom' ? [{ id: 'custom', title: t('session.follow.policy.custom'), disabled: true }] : []),
                ];
                return (
                    <DropdownMenu
                        key={row.field}
                        testID={`settings-coordination-level-${row.field}`}
                        open={openField === row.field}
                        onOpenChange={(next) => setOpenField(next ? row.field : null)}
                        variant="selectable"
                        search={false}
                        selectedId={policy.preset}
                        showCategoryTitles={false}
                        matchTriggerWidth={true}
                        connectToTrigger={true}
                        rowKind="item"
                        popoverBoundaryRef={props.popoverBoundaryRef}
                        itemTrigger={{
                            title: t(row.title),
                            subtitle: t(row.subtitle),
                            showSelectedSubtitle: false,
                            itemProps: { subtitleLines: 0, disabled: !online || saving },
                        }}
                        items={items}
                        onSelect={(id) => {
                            setOpenField(null);
                            if (id === policy.preset || !LEVEL_PRESETS.includes(id as LevelPreset)) return;
                            void save({ patch: { [row.field]: { preset: id as LevelPreset } } });
                        }}
                    />
                );
            }) : <Item title={t('common.loading')} loading={!error && online} mode="info" />}
            {!online || error ? <Item
                testID="settings-coordination-levels-error"
                title={!online ? t('session.follow.offline') : t('errors.unknownError')}
                titleLines={0}
                mode="info"
                accessibilityLiveRegion="polite"
            /> : null}
            {online && error ? <Item
                testID="settings-coordination-levels-retry"
                title={t('common.retry')}
                onPress={retry}
                showChevron={false}
            /> : null}
        </ItemGroup>
    );
}

/** The four default rules, each a level, for the active Home (moved here from Notifications). */
function FollowAutomaticallyGroup() {
    const activeServer = useActiveServerSnapshot();
    return <SessionAutoFollowPreferencesSection key={activeServer.serverId} serverId={activeServer.serverId} />;
}

function CheckInGroup() {
    const [checkIn, setCheckIn] = useSettingMutable('coordinationAutonomousCheckIn');
    const neverPause = checkIn.afterTurns === null;
    // Never pause keeps no count; turning it off brings back the one shown, so the stepper never goes blank.
    const lastTurns = React.useRef(checkIn.afterTurns ?? DEFAULT_CHECK_IN_TURNS);
    if (checkIn.afterTurns !== null) lastTurns.current = checkIn.afterTurns;
    return (
        <SettingSection section={COORDINATION_SETTINGS.sectionRefs.checkIn}>
            <ItemGroup title={t('settingsCoordination.checkInTitle')} description={t('settingsCoordination.checkInDescription')}>
                <SettingAnchor setting={SETTINGS.autonomousCheckIn}>
                    <FieldValueItem
                        testID="settings-coordination-pause-after"
                        fieldTestID="settings-coordination-pause-after-input"
                        title={t('settingsCoordination.pauseAfter')}
                        subtitle={neverPause ? t('settingsCoordination.pauseAfterOff') : t('settingsCoordination.pauseAfterDescription')}
                        subtitleLines={0}
                        kind="integer"
                        stepper={{ min: 1, step: 1 }}
                        compactStepper
                        disabled={neverPause}
                        value={String(lastTurns.current)}
                        onCommit={(draft) => {
                            const turns = parseCheckInTurns(draft);
                            if (turns === null) return String(lastTurns.current);
                            setCheckIn({ afterTurns: turns });
                            return String(turns);
                        }}
                    />
                </SettingAnchor>
                <Item
                    testID="settings-coordination-never-pause"
                    title={t('settingsCoordination.neverPause')}
                    subtitle={neverPause ? t('settingsCoordination.neverPauseWarning') : t('settingsCoordination.neverPauseDescription')}
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={<Switch
                        accessibilityLabel={t('settingsCoordination.neverPause')}
                        value={neverPause}
                        onValueChange={(next) => setCheckIn(withNeverPause(next, lastTurns.current))}
                    />}
                />
                {neverPause ? null : (
                    <Item
                        testID="settings-coordination-check-in-preview"
                        title={t('settingsCoordination.checkInPreview')}
                        accessoryLayout="stacked"
                        showChevron={false}
                        rightElement={<ExchangeCheckInBannerPreview count={lastTurns.current} />}
                    />
                )}
            </ItemGroup>
        </SettingSection>
    );
}

const styles = StyleSheet.create((theme) => ({
    keepControls: { gap: theme.space.s12, alignItems: 'flex-start' },
    keepCaption: { color: theme.colors.text.secondary },
}));
