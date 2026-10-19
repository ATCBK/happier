import * as React from 'react';
import { Animated, Easing, Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize, resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { SelectionListFilterChip, type SelectionListFilter } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

import { SessionListViewOptionsButton, stopPressEventPropagation } from '../sessionListChrome';
import { SESSION_LIST_COLUMN_METRICS, sessionListStyles } from '../sessionListStyles';

const SEARCH_FIELD_FADE_MS = 170;
/** The retry and Search everything rows keep the platform's minimum target. */
const MINIMUM_ESCALATION_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);
const MINIMUM_ESCALATION_TARGET_STYLE = {
    minWidth: MINIMUM_ESCALATION_TARGET_SIZE,
    minHeight: MINIMUM_ESCALATION_TARGET_SIZE,
};
type Focusable = Readonly<{ focus: () => void }>;


export type SessionListSearchChromeProps = Readonly<{
    filterControl?: React.ReactNode;
    filterSummary?: Readonly<{ label: string; onReset(): void }>;
    /** Facets that are on without showing in the title; each chip turns its own facet off. */
    filterChips?: ReadonlyArray<SelectionListFilter>;
    /** A fixed Run window has a quiet summary, not a second Sessions scope title. */
    presentation?: 'sessions' | 'runs';
    searchQuery: string;
    /** Exact Home whose transcript provider supplies contextual matches. */
    searchScopeLabel?: string;
    organizationServerId?: string | null;
    searchTrailingAccessory?: React.ReactNode;
    searchStatus?: Readonly<{
        message: string;
        onRetry?: () => void;
    }>;
    onSearchQueryChange: (query: string) => void;
    /**
     * Opens the universal Search surface with the contextual query preserved. The
     * session list never renders universal results itself.
     */
    onSearchEverything?: (query: string) => void;
}>;

/**
 * Stable, non-virtualized sibling of the one virtualized session-results list.
 *
 * The title row — the list's scope title, the search toggle and View options — and, while search is
 * open, the compact search field on its own row beneath it live here, never inside virtualized row
 * data, so typing, provider publication, filtering and zero-result rebuilds cannot remount the input.
 * The field is the shared `CompactSearchField`: a leading magnifying glass, the input, and one
 * trailing close button. Close and Escape clear the query,
 * collapse the field and return focus to the search toggle.
 */
export const SessionListSearchChrome = React.memo(function SessionListSearchChrome(
    props: SessionListSearchChromeProps,
) {
    const {
        filterControl,
        onSearchEverything,
        onSearchQueryChange,
        searchQuery,
        searchScopeLabel,
        searchStatus,
        searchTrailingAccessory,
    } = props;
    const styles = sessionListStyles;
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const trimmedQuery = searchQuery.trim();
    const [searchOpened, setSearchOpened] = React.useState(false);
    const [searchFocused, setSearchFocused] = React.useState(false);
    const searchIsOpen = searchOpened || trimmedQuery.length > 0;
    const fieldOpacity = React.useRef(new Animated.Value(searchIsOpen ? 1 : 0)).current;
    const toggleRef = React.useRef<Focusable | null>(null);
    // The header's icon buttons and the field's close button take the touch floor only where the primary
    // pointer is a finger; a pointer column keeps the lab's compact squares.
    const touchTargetSize = resolveTouchTargetFloorPx() ?? undefined;
    const iconColor = theme.colors.text.secondary;

    React.useEffect(() => {
        Animated.timing(fieldOpacity, {
            toValue: searchIsOpen ? 1 : 0,
            duration: reducedMotion ? 0 : SEARCH_FIELD_FADE_MS,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: Platform.OS !== 'web',
        }).start();
    }, [fieldOpacity, reducedMotion, searchIsOpen]);

    const handleToggleRef = React.useCallback((instance: Focusable | null) => {
        toggleRef.current = instance;
    }, []);

    const closeSearch = React.useCallback(() => {
        onSearchQueryChange('');
        setSearchOpened(false);
        setSearchFocused(false);
        // The field that held focus is gone: hand focus back to the control that opened it.
        toggleRef.current?.focus?.();
    }, [onSearchQueryChange]);

    const handleToggleSearch = React.useCallback((event?: unknown) => {
        stopPressEventPropagation(event);
        if (searchIsOpen) {
            closeSearch();
            return;
        }
        setSearchOpened(true);
        setSearchFocused(true);
    }, [closeSearch, searchIsOpen]);

    const handleSearchFocus = React.useCallback(() => {
        // Once explicitly focused, the field owns a stable open lifetime until
        // the user explicitly closes it. Native clear gestures can emit blur as
        // part of platform focus transfer; that must not remount the field.
        setSearchOpened(true);
        setSearchFocused(true);
    }, []);

    const handleSearchBlur = React.useCallback(() => {
        setSearchFocused(false);
    }, []);

    const handleSearchKeyPress = React.useCallback((event: { nativeEvent?: { key?: string } }) => {
        if (event.nativeEvent?.key !== 'Escape') return;
        closeSearch();
    }, [closeSearch]);

    const handleCloseSearch = React.useCallback((event?: unknown) => {
        stopPressEventPropagation(event);
        closeSearch();
    }, [closeSearch]);

    const handleSearchEverything = React.useCallback((event?: unknown) => {
        stopPressEventPropagation(event);
        onSearchEverything?.(trimmedQuery);
    }, [onSearchEverything, trimmedQuery]);

    const handleRetrySearch = React.useCallback((event?: unknown) => {
        stopPressEventPropagation(event);
        searchStatus?.onRetry?.();
    }, [searchStatus]);

    const resetControl = props.filterSummary ? <HappierPressable
        testID="session-list-filter-summary-reset"
        accessibilityRole="button"
        accessibilityLabel={t('common.reset')}
        onPress={props.filterSummary.onReset}
        style={(state) => [
            styles.searchChromeStatusRetry,
            // A finger gets the platform floor; a pointer keeps the quiet line's own height.
            touchTargetSize ? { minWidth: touchTargetSize, minHeight: touchTargetSize } : null,
            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
        ]}
    ><Text style={styles.searchChromeStatusActionText}>{t('common.reset')}</Text></HappierPressable> : null;

    return (
        <View style={styles.searchChrome} testID="session-list-search-chrome">
            <View
                testID="session-list-search-primary-controls"
                style={[styles.searchChromeControlsRow, props.presentation === 'runs' ? styles.searchChromeSummaryRow : null]}
            >
                <View testID="session-list-title-slot" style={styles.searchChromeTitleSlot}>
                    {filterControl}
                </View>
                <IconButton
                    testID="session-list-search-trigger"
                    accessibilityLabel={t('sessionsList.searchSessions')}
                    tooltip={t('sessionsList.searchSessions')}
                    variant="plain"
                    size={SESSION_LIST_COLUMN_METRICS.iconButtonSizePx}
                    iconSize={ICON_SIZE.sm}
                    minimumInteractiveTargetSize={touchTargetSize}
                    interactiveTargetGapPx={SESSION_LIST_COLUMN_METRICS.iconButtonGapPx}
                    selected={searchIsOpen}
                    controlRef={handleToggleRef}
                    iconName="magnifying-glass"
                    onPress={handleToggleSearch}
                />
                {props.presentation === 'runs' ? resetControl : <SessionListViewOptionsButton
                    placement="bottom"
                    serverId={props.organizationServerId}
                    minimumInteractiveTargetSize={touchTargetSize}
                />}
            </View>
            {props.filterSummary && props.presentation !== 'runs' ? (
                <View testID="session-list-filter-summary" style={styles.searchChromeStatusRow}>
                    <Text style={styles.searchChromeStatusText}>{props.filterSummary.label}</Text>
                    {resetControl}
                </View>
            ) : null}
            {props.filterChips && props.filterChips.length > 0 && props.presentation !== 'runs' ? (
                <View testID="session-list-filter-chips" style={styles.searchChromeChipRow}>
                    {props.filterChips.map((filter) => <SelectionListFilterChip key={filter.id} filter={filter} />)}
                </View>
            ) : null}
            {searchIsOpen ? (
                <Animated.View style={{ opacity: fieldOpacity }}>
                    <CompactSearchField
                        testID="session-list-search-input"
                        accessibilityLabel={t('sessionsList.searchSessions')}
                        placeholder={t('sessionsList.searchSessionsPlaceholder')}
                        value={searchQuery}
                        onChangeText={onSearchQueryChange}
                        onFocus={handleSearchFocus}
                        onBlur={handleSearchBlur}
                        onKeyPress={handleSearchKeyPress}
                        // Only the explicit open path focuses; a retained query restoring
                        // this surface must not steal focus on mount.
                        autoFocus={searchFocused}
                        style={styles.searchChromeField}
                        trailing={(
                            <>
                                {searchTrailingAccessory !== undefined ? (
                                    <View
                                        testID="session-list-search-trailing-accessory"
                                        pointerEvents="none"
                                        accessibilityElementsHidden={true}
                                        importantForAccessibility="no-hide-descendants"
                                        style={styles.headerSearchTrailingAccessory}
                                    >
                                        {searchTrailingAccessory}
                                    </View>
                                ) : null}
                                <IconButton
                                    testID="session-list-search-close"
                                    accessibilityLabel={t('sessionsList.closeSearch')}
                                    variant="plain"
                                    size={SESSION_LIST_COLUMN_METRICS.fieldCloseButtonSizePx}
                                    iconSize={ICON_SIZE.xs}
                                    minimumInteractiveTargetSize={touchTargetSize}
                                    iconName="x"
                                    onPress={handleCloseSearch}
                                />
                            </>
                        )}
                    />
                </Animated.View>
            ) : null}
            {searchScopeLabel && trimmedQuery.length > 0 ? (
                <View
                    testID="session-list-search-scope"
                    accessibilityLiveRegion="polite"
                    style={styles.searchChromeScopeRow}
                >
                    <Icon name="hard-drives" size={13} color={iconColor} />
                    <Text style={styles.searchChromeScopeText}>{searchScopeLabel}</Text>
                </View>
            ) : null}
            {searchStatus && trimmedQuery.length > 0 ? (
                <View
                    testID="session-list-search-status"
                    accessibilityLiveRegion="polite"
                    role={Platform.OS === 'web' ? 'status' : undefined}
                    style={styles.searchChromeStatusRow}
                >
                    <Text style={styles.searchChromeStatusText}>{searchStatus.message}</Text>
                    {searchStatus.onRetry ? (
                        <Pressable
                            testID="session-list-search-retry"
                            accessibilityRole="button"
                            accessibilityLabel={t('common.retry')}
                            onPress={handleRetrySearch}
                            style={[styles.searchChromeStatusRetry, MINIMUM_ESCALATION_TARGET_STYLE]}
                        >
                            <Text style={styles.searchChromeStatusRetryText}>{t('common.retry')}</Text>
                        </Pressable>
                    ) : null}
                </View>
            ) : null}
            {onSearchEverything && trimmedQuery.length > 0 ? (
                <Pressable
                    testID="session-list-search-everything"
                    accessibilityRole="button"
                    accessibilityLabel={t('sessionsList.searchEverythingFor', { query: trimmedQuery })}
                    onPress={handleSearchEverything}
                    style={[styles.searchChromeEscalationRow, MINIMUM_ESCALATION_TARGET_STYLE]}
                >
                    <Icon name="magnifying-glass" size={14} color={iconColor} />
                    <Text style={styles.searchChromeEscalationText}>
                        {t('sessionsList.searchEverythingFor', { query: trimmedQuery })}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
});
