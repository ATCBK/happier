import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { SelectionTiles, type SelectionTile } from '@/components/ui/forms/SelectionTiles';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { ITEM_SUBTITLE_TEXT_METRICS, ITEM_TITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import type { SelectionListOption, SelectionListStep } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { SESSION_LIST_FILTER_ARCHIVED_DESTINATION_OPTION_ID } from './sessionListFilterEditorModel';

/** The facets whose full list opens in place of the panel (searchable, paginated, or nested). */
export type SessionListFilterDrillSection = 'tags' | 'audiences' | 'projects';

export type SessionListFilterPanelCopy = Readonly<{
    show: string;
    scope: string;
    startedBy: string;
    runsNeedingYouAlwaysShow: string;
    needsMeOnly: string;
    needsMeOnlyDescription: string;
    inactiveSessions: string;
    homes: string;
    sharedWith: string;
    tags: string;
    status: string;
    project: string;
    source: string;
    clear: string;
    done: string;
    moreTags: (count: number) => string;
    resultCount: (count: number) => string;
}>;

export type SessionListFilterPanelProps = Readonly<{
    /** The editor model's root step: the one owner of which facets and choices exist. */
    rootStep: SelectionListStep;
    selectedIds: ReadonlySet<string>;
    labels: SessionListFilterPanelCopy;
    /** Sessions the list shows for the current choices (the list's own count). */
    resultCount?: number;
    /** A host whose result isn't a plain count (a live preview that can be partial) words it itself. */
    resultSummary?: string;
    maxHeight?: number;
    /** Hands one model option id back to the editor's single writer. */
    onSelect(optionId: string): void;
    onOpenDrill(section: SessionListFilterDrillSection): void;
    /** The Teams audience list is live even before it has rows (its directory is still answering). */
    audiencesAvailable?: boolean;
    onReset(): void;
    onDone?: () => void;
    /** Done waits until the host's result can be used (a preview still checking, or nothing to use). */
    doneDisabled?: boolean;
}>;

/**
 * Tag chips shown in the panel before "+N more". The panel keeps a stable size — at most two chip
 * rows at its width — and every tag stays one tap away in the searchable list.
 */
const INLINE_TAG_CHIP_COUNT = 5;

const MINIMUM_INTERACTIVE_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);
const FOOTER_MIN_HEIGHT = 52;
/** The footer row's gap between its actions; the icon action's press frame grows into half of it. */
const FOOTER_ACTION_GAP = 8;
const ROW_TEXT = ITEM_TITLE_TEXT_METRICS.compact;
const SUBTITLE_TEXT = ITEM_SUBTITLE_TEXT_METRICS.compact;

const SCOPE_ICONS: Readonly<Record<string, IconName>> = {
    'scope:my_work': 'user-circle',
    'scope:assigned_to_me': 'at',
    'scope:following': 'eye',
    'scope:involving_me': 'users',
    'scope:all_accessible': 'globe',
    [SESSION_LIST_FILTER_ARCHIVED_DESTINATION_OPTION_ID]: 'archive',
};

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        minWidth: 280,
    },
    body: {
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s12,
        paddingBottom: 14,
    },
    sectionLabel: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta', 'medium'),
        marginTop: 14,
        marginBottom: theme.space.s8,
        marginHorizontal: theme.space.s2,
    },
    sectionLabelFirst: {
        marginTop: 0,
    },
    /** A section label that shares its line with the section's own control (Project · Is | Isn't). */
    sectionRow: {
        marginTop: theme.space.s6,
        marginBottom: theme.space.s4,
        marginHorizontal: theme.space.s2,
    },
    sectionLabelInline: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta', 'medium'),
    },
    row: {
        minHeight: MINIMUM_INTERACTIVE_TARGET_SIZE,
        marginTop: theme.space.s8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    rowPressable: {
        borderRadius: 8,
        borderWidth: 1,
        borderColor: 'transparent',
        marginHorizontal: -6,
        paddingHorizontal: theme.space.s6,
    },
    rowPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    rowText: {
        flex: 1,
        minWidth: 0,
    },
    rowTitle: {
        ...Typography.default(),
        color: theme.colors.text.primary,
        fontSize: ROW_TEXT.fontSize,
        lineHeight: ROW_TEXT.lineHeight,
        letterSpacing: ROW_TEXT.letterSpacing,
    },
    rowSubtitle: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: SUBTITLE_TEXT.fontSize,
        lineHeight: SUBTITLE_TEXT.lineHeight,
        letterSpacing: SUBTITLE_TEXT.letterSpacing,
    },
    rowValue: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: SUBTITLE_TEXT.fontSize,
        lineHeight: SUBTITLE_TEXT.lineHeight,
        fontVariant: ['tabular-nums'],
    },
    chips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s6,
    },
    chip: {
        minHeight: 28,
        paddingHorizontal: theme.space.s10,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.border.strong,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    chipSelected: {
        backgroundColor: theme.colors.button.primary.background,
        borderColor: theme.colors.button.primary.background,
    },
    chipPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    chipDisabled: {
        opacity: 0.5,
    },
    chipLabel: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: SUBTITLE_TEXT.fontSize,
        lineHeight: SUBTITLE_TEXT.lineHeight,
    },
    chipLabelSelected: {
        ...Typography.default('medium'),
        color: theme.colors.button.primary.tint,
    },
    footer: {
        minHeight: FOOTER_MIN_HEIGHT,
        paddingLeft: 14,
        paddingRight: theme.space.s8,
        paddingVertical: theme.space.s4,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
        flexDirection: 'row',
        alignItems: 'center',
        gap: FOOTER_ACTION_GAP,
    },
    footerCount: {
        flex: 1,
        minWidth: 0,
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: SUBTITLE_TEXT.fontSize,
        lineHeight: SUBTITLE_TEXT.lineHeight,
        fontVariant: ['tabular-nums'],
    },
    footerButton: {
        minHeight: MINIMUM_INTERACTIVE_TARGET_SIZE,
    },
}));

function staticOptions(rootStep: SelectionListStep, sectionId: string): readonly SelectionListOption[] | null {
    const section = rootStep.sections.find((candidate) => candidate.id === sectionId);
    return section && section.kind === 'static' ? section.options : null;
}

const FilterChip = React.memo(function FilterChip(props: Readonly<{
    testID: string;
    label: string;
    selected?: boolean;
    disabled?: boolean;
    targetSize?: 'platform';
    /** A chip that opens more choices instead of toggling one. */
    kind?: 'toggle' | 'more';
    onPress(): void;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const selected = props.kind !== 'more' && props.selected === true;
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityRole={props.kind === 'more' ? 'button' : 'checkbox'}
            checked={props.kind === 'more' ? undefined : selected}
            accessibilityLabel={props.label}
            disabled={props.disabled}
            onPress={props.onPress}
            style={(state) => [
                styles.chip,
                props.targetSize === 'platform' ? { minHeight: MINIMUM_INTERACTIVE_TARGET_SIZE, minWidth: MINIMUM_INTERACTIVE_TARGET_SIZE } : null,
                selected ? styles.chipSelected : null,
                state.pressed && !selected ? styles.chipPressed : null,
                props.disabled ? styles.chipDisabled : null,
                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
            ]}
        >
            {selected ? <Icon name="check" size={12} color={theme.colors.button.primary.tint} /> : null}
            <Text numberOfLines={1} style={[styles.chipLabel, selected ? styles.chipLabelSelected : null]}>
                {props.label}
            </Text>
        </HappierPressable>
    );
});

/**
 * The scope and filter panel: every facet the editor model offers, visible at once. It owns no
 * filter state — each control hands a model option id back to the editor's one writer, and the
 * facets whose lists are long, searchable or nested open in place (`onOpenDrill`).
 */
export const SessionListFilterPanel = React.memo(function SessionListFilterPanel(
    props: SessionListFilterPanelProps,
) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { labels, onSelect, rootStep, selectedIds } = props;

    const scopeTiles = React.useMemo<Array<SelectionTile<string>>>(() => (
        (staticOptions(rootStep, 'show') ?? [])
            // Only choices the corpus can answer are offered; an unavailable scope is not a dead tile.
            .filter((option) => option.disabled !== true)
            .map((option) => ({
                id: option.id,
                title: option.label,
                icon: SCOPE_ICONS[option.id],
            }))
    ), [rootStep]);
    const selectedScopeId = scopeTiles.find((tile) => selectedIds.has(tile.id))?.id ?? null;
    const handleScopeChange = React.useCallback((next: string | null) => {
        if (next) onSelect(next);
    }, [onSelect]);

    const attentionOptions = staticOptions(rootStep, 'attention');
    const coordinatorOption = staticOptions(rootStep, 'coordinator')?.[0];
    const showOptions = staticOptions(rootStep, 'work-kind');
    const starterOptions = staticOptions(rootStep, 'started-by');
    const showTabs = React.useMemo(() => (showOptions ?? []).map((option) => ({ id: option.id, label: option.label })), [showOptions]);
    const activeShowTab = showTabs.find((tab) => selectedIds.has(tab.id))?.id ?? showTabs[0]?.id;
    const inactiveOptions = staticOptions(rootStep, 'inactive');
    const homeOptions = staticOptions(rootStep, 'homes');
    const audienceOptions = staticOptions(rootStep, 'audiences');
    const tagOptions = staticOptions(rootStep, 'tags');
    const statusOptions = staticOptions(rootStep, 'status');
    const projectOptions = staticOptions(rootStep, 'projects');
    const projectModeOptions = staticOptions(rootStep, 'project-mode');
    const sourceOptions = staticOptions(rootStep, 'source');

    const needsMe = selectedIds.has('attention:needs_my_attention');
    const handleNeedsMeChange = React.useCallback((value: boolean) => {
        onSelect(value ? 'attention:needs_my_attention' : 'attention:any');
    }, [onSelect]);
    const coordinatorsOnly = coordinatorOption ? selectedIds.has(coordinatorOption.id) : false;
    const handleCoordinatorsOnlyChange = React.useCallback((value: boolean) => {
        if (coordinatorOption && value !== coordinatorsOnly) onSelect(coordinatorOption.id);
    }, [coordinatorOption, coordinatorsOnly, onSelect]);

    const inactiveTabs = React.useMemo(() => (inactiveOptions ?? []).map((option) => ({
        id: option.id,
        label: option.label,
    })), [inactiveOptions]);
    const activeInactiveTab = inactiveTabs.find((tab) => selectedIds.has(tab.id))?.id ?? inactiveTabs[0]?.id;
    const sourceTabs = React.useMemo(() => (sourceOptions ?? []).map((option) => ({
        id: option.id,
        label: option.label,
    })), [sourceOptions]);
    const activeSourceTab = sourceTabs.find((tab) => selectedIds.has(tab.id))?.id ?? sourceTabs[0]?.id;

    const inlineTags = React.useMemo(() => {
        if (!tagOptions) return [];
        const selected = tagOptions.filter((option) => selectedIds.has(option.id));
        const unselected = tagOptions.filter((option) => !selectedIds.has(option.id));
        return [...selected, ...unselected].slice(0, INLINE_TAG_CHIP_COUNT);
    }, [selectedIds, tagOptions]);
    const hiddenTagCount = (tagOptions?.length ?? 0) - inlineTags.length;
    const inlineProjects = React.useMemo(() => {
        if (!projectOptions) return [];
        const selected = projectOptions.filter((option) => selectedIds.has(option.id));
        const unselected = projectOptions.filter((option) => !selectedIds.has(option.id));
        return [...selected, ...unselected].slice(0, INLINE_TAG_CHIP_COUNT);
    }, [projectOptions, selectedIds]);
    const hiddenProjectCount = (projectOptions?.length ?? 0) - inlineProjects.length;
    const projectModeTabs = React.useMemo(() => (projectModeOptions ?? []).map((option) => ({
        id: option.id,
        label: option.label,
    })), [projectModeOptions]);
    const activeProjectMode = projectModeTabs.find((tab) => selectedIds.has(tab.id))?.id ?? projectModeTabs[0]?.id;
    const selectedAudienceCount = React.useMemo(() => {
        let count = 0;
        for (const id of selectedIds) if (id.startsWith('audience:')) count += 1;
        return count;
    }, [selectedIds]);

    const footerHeight = FOOTER_MIN_HEIGHT;
    const bodyMaxHeight = props.maxHeight === undefined ? undefined : Math.max(0, props.maxHeight - footerHeight);

    return (
        <View testID="session-list-filter-panel" style={styles.root}>
            <ScrollView
                style={bodyMaxHeight === undefined ? undefined : { maxHeight: bodyMaxHeight }}
                contentContainerStyle={styles.body}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator
            >
                {showOptions && activeShowTab ? (
                    <>
                        <Text style={[styles.sectionLabel, styles.sectionLabelFirst]}>{labels.show}</Text>
                        <SegmentedTabBar<string>
                            role="radiogroup"
                            tabs={showTabs}
                            activeTabId={activeShowTab}
                            onSelectTab={onSelect}
                            accessibilityLabel={labels.show}
                            testIDPrefix="session-list-filter"
                            targetSize="platform"
                        />
                    </>
                ) : null}
                {starterOptions ? (
                    <>
                        <Text style={[styles.sectionLabel, !showOptions ? styles.sectionLabelFirst : null]}>{labels.startedBy}</Text>
                        <View style={styles.chips} accessibilityLabel={labels.startedBy}>
                            {starterOptions.map((option) => (
                                <FilterChip
                                    key={option.id}
                                    testID={`session-list-filter:${option.id}`}
                                    label={option.label}
                                    selected={selectedIds.has(option.id)}
                                    targetSize="platform"
                                    onPress={() => onSelect(option.id)}
                                />
                            ))}
                        </View>
                        <Text style={[styles.rowSubtitle, { marginTop: theme.space.s8 }]}>{labels.runsNeedingYouAlwaysShow}</Text>
                    </>
                ) : null}
                {scopeTiles.length > 0 ? (
                    <>
                        <Text style={[styles.sectionLabel, !showOptions && !starterOptions ? styles.sectionLabelFirst : null]}>{labels.scope}</Text>
                        <SelectionTiles<string>
                            options={scopeTiles}
                            value={selectedScopeId}
                            onChange={handleScopeChange}
                            density="compact"
                            minimumColumns={2}
                            accessibilityLabel={labels.scope}
                            testIdPrefix="session-list-filter-scope"
                        />
                    </>
                ) : null}

                {attentionOptions ? (
                    <View style={styles.row}>
                        <View style={styles.rowText}>
                            <Text style={styles.rowTitle}>{labels.needsMeOnly}</Text>
                            <Text style={styles.rowSubtitle}>{labels.needsMeOnlyDescription}</Text>
                        </View>
                        <Switch
                            testID="session-list-filter-attention"
                            accessibilityLabel={labels.needsMeOnly}
                            value={needsMe}
                            onValueChange={handleNeedsMeChange}
                        />
                    </View>
                ) : null}

                {coordinatorOption ? (
                    <View style={styles.row}>
                        <View style={styles.rowText}>
                            <Text style={styles.rowTitle}>{coordinatorOption.label}</Text>
                            {coordinatorOption.subtitle ? <Text style={styles.rowSubtitle}>{coordinatorOption.subtitle}</Text> : null}
                        </View>
                        <Switch
                            testID="session-list-filter-coordinators"
                            accessibilityLabel={coordinatorOption.label}
                            value={coordinatorsOnly}
                            onValueChange={handleCoordinatorsOnlyChange}
                        />
                    </View>
                ) : null}

                {statusOptions ? (
                    <>
                        <Text style={styles.sectionLabel}>{labels.status}</Text>
                        <View style={styles.chips} accessibilityLabel={labels.status}>
                            {statusOptions.map((option) => (
                                <FilterChip
                                    key={option.id}
                                    testID={`session-list-filter:${option.id}`}
                                    label={option.label}
                                    selected={selectedIds.has(option.id)}
                                    onPress={() => onSelect(option.id)}
                                />
                            ))}
                        </View>
                    </>
                ) : null}

                {projectOptions ? (
                    <>
                        <View style={[styles.row, styles.sectionRow]}>
                            <Text style={[styles.sectionLabelInline, styles.rowText]}>{labels.project}</Text>
                            {/* Is | Isn't qualifies chosen projects, so it appears once one is chosen. */}
                            {projectModeTabs.length > 0 && activeProjectMode && inlineProjects.some((option) => selectedIds.has(option.id)) ? (
                                <View>
                                    <SegmentedTabBar<string>
                                        role="radiogroup"
                                        tabs={projectModeTabs}
                                        activeTabId={activeProjectMode}
                                        onSelectTab={onSelect}
                                        segmentSizing="content"
                                        accessibilityLabel={labels.project}
                                        testIDPrefix="session-list-filter"
                                    />
                                </View>
                            ) : null}
                        </View>
                        <View style={styles.chips} accessibilityLabel={labels.project}>
                            {inlineProjects.map((option) => (
                                <FilterChip
                                    key={option.id}
                                    testID={`session-list-filter:${option.id}`}
                                    label={option.label}
                                    selected={selectedIds.has(option.id)}
                                    disabled={option.disabled === true}
                                    onPress={() => onSelect(option.id)}
                                />
                            ))}
                            {hiddenProjectCount > 0 ? (
                                <FilterChip
                                    kind="more"
                                    testID="session-list-filter-projects-more"
                                    label={labels.moreTags(hiddenProjectCount)}
                                    onPress={() => props.onOpenDrill('projects')}
                                />
                            ) : null}
                        </View>
                    </>
                ) : null}

                {inactiveOptions && activeInactiveTab ? (
                    <View style={styles.row}>
                        <Text style={[styles.rowTitle, styles.rowText]}>{labels.inactiveSessions}</Text>
                        <View>
                            <SegmentedTabBar<string>
                                role="radiogroup"
                                tabs={inactiveTabs}
                                activeTabId={activeInactiveTab}
                                onSelectTab={onSelect}
                                segmentSizing="content"
                                accessibilityLabel={labels.inactiveSessions}
                                testIDPrefix="session-list-filter"
                            />
                        </View>
                    </View>
                ) : null}

                {homeOptions ? (
                    <>
                        <Text style={styles.sectionLabel}>{labels.homes}</Text>
                        <View style={styles.chips} accessibilityLabel={labels.homes}>
                            {homeOptions.map((option) => (
                                <FilterChip
                                    key={option.id}
                                    testID={`session-list-filter:${option.id}`}
                                    label={option.label}
                                    selected={selectedIds.has(option.id)}
                                    disabled={option.disabled === true}
                                    onPress={() => onSelect(option.id)}
                                />
                            ))}
                        </View>
                    </>
                ) : null}

                {audienceOptions || props.audiencesAvailable ? (
                    <HappierPressable
                        testID="session-list-filter-audiences"
                        accessibilityRole="button"
                        accessibilityLabel={labels.sharedWith}
                        onPress={() => props.onOpenDrill('audiences')}
                        style={(state) => [
                            styles.row,
                            styles.rowPressable,
                            state.pressed ? styles.rowPressed : null,
                            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                        ]}
                    >
                        <Text style={[styles.rowTitle, styles.rowText]}>{labels.sharedWith}</Text>
                        {selectedAudienceCount > 0 ? (
                            <Text style={styles.rowValue}>{String(selectedAudienceCount)}</Text>
                        ) : null}
                        <Icon name="caret-right" size={14} color={theme.colors.text.tertiary} />
                    </HappierPressable>
                ) : null}

                {tagOptions ? (
                    <>
                        <Text style={styles.sectionLabel}>{labels.tags}</Text>
                        <View style={styles.chips} accessibilityLabel={labels.tags}>
                            {inlineTags.map((option) => (
                                <FilterChip
                                    key={option.id}
                                    testID={`session-list-filter:${option.id}`}
                                    label={option.label}
                                    selected={selectedIds.has(option.id)}
                                    disabled={option.disabled === true}
                                    onPress={() => onSelect(option.id)}
                                />
                            ))}
                            {hiddenTagCount > 0 ? (
                                <FilterChip
                                    kind="more"
                                    testID="session-list-filter-tags-more"
                                    label={labels.moreTags(hiddenTagCount)}
                                    onPress={() => props.onOpenDrill('tags')}
                                />
                            ) : null}
                        </View>
                    </>
                ) : null}

                {sourceOptions && activeSourceTab ? (
                    <View style={[styles.row, { marginTop: 14 }]}>
                        <Text style={[styles.rowTitle, styles.rowText]}>{labels.source}</Text>
                        <View>
                            <SegmentedTabBar<string>
                                role="radiogroup"
                                tabs={sourceTabs}
                                activeTabId={activeSourceTab}
                                onSelectTab={onSelect}
                                segmentSizing="content"
                                accessibilityLabel={labels.source}
                                testIDPrefix="session-list-filter"
                            />
                        </View>
                    </View>
                ) : null}
            </ScrollView>
            <View style={styles.footer}>
                <Text
                    testID="session-list-filter-result-count"
                    style={styles.footerCount}
                    numberOfLines={1}
                    accessibilityLiveRegion="polite"
                >
                    {props.resultSummary ?? (props.resultCount === undefined ? '' : labels.resultCount(props.resultCount))}
                </Text>
                <IconButton
                    testID="session-list-filter-clear"
                    iconName="arrow-arc-left"
                    accessibilityLabel={labels.clear}
                    tooltip={labels.clear}
                    variant="plain"
                    minimumInteractiveTargetSize={MINIMUM_INTERACTIVE_TARGET_SIZE}
                    interactiveTargetGapPx={FOOTER_ACTION_GAP}
                    onPress={props.onReset}
                />
                {props.onDone ? (
                    <ToolbarButton
                        label={labels.done}
                        tone="primary"
                        onPress={props.onDone}
                        disabled={props.doneDisabled}
                        testID="session-list-filter-done"
                        style={styles.footerButton}
                    />
                ) : null}
            </View>
        </View>
    );
});
