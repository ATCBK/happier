import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import {
    View,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { WorkflowRunInvocationIndexV1 } from '@happier-dev/protocol';

import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { VirtualizedList, type VirtualizedListRef } from '@/components/ui/lists/virtualized';

import { WorkflowLifecycleStatus } from '@/components/workflows/presentation/WorkflowLifecycleStatus';
import {
    describeWorkflowInvocationAttempt,
    describeWorkflowInvocationLifecycle,
    type WorkflowInvocationLifecycleContext,
} from '@/components/workflows/presentation/workflowLifecyclePresentation';

/**
 * The Run's invocation outline.
 *
 * Rows are the canonical index the server returned, in the order it returned
 * them. Pagination is presentation infrastructure, not a completeness cliff:
 * every admitted row stays reachable, and a still-loading page says so instead
 * of looking like the end of history.
 *
 * Counters render the canonical decimal strings verbatim. They are never parsed
 * into numbers, because these counters are 64-bit on the server and a JSON
 * number would silently lose precision.
 */

/**
 * Rows and the paging action draw at the WCAG 2.2 pointer floor under every pointer; a finger reaches
 * its touch target through the `HappierPressable` hit area past this drawn box.
 */
const MINIMUM_TARGET_SIZE = HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE;

const styles = StyleSheet.create((theme) => ({
    scroll: {
        flex: 1,
    },
    list: {
        gap: theme.space.s4,
    },
    listHeader: {
        marginBottom: theme.space.s16,
    },
    listFooter: {
        marginTop: theme.space.s16,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingVertical: theme.space.s8,
        minHeight: MINIMUM_TARGET_SIZE,
        borderWidth: 1,
        borderColor: 'transparent',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    rowSelected: {
        backgroundColor: theme.colors.surface.selected,
    },
    rail: {
        width: StyleSheet.hairlineWidth,
        alignSelf: 'stretch',
        backgroundColor: theme.colors.border.default,
    },
    label: {
        ...Typography.variant('label', 'regular'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    identity: {
        flex: 1,
        minWidth: 0,
    },
    occurrence: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    labelSelected: {
        ...Typography.default('semiBold'),
    },
    ordinal: {
        ...Typography.variant('micro'),
        ...Typography.tabular(),
        color: theme.colors.text.tertiary,
    },
    trailing: {
        marginLeft: 'auto',
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    footer: {
        paddingVertical: theme.space.s12,
        alignItems: 'center',
    },
    footerTarget: {
        minHeight: MINIMUM_TARGET_SIZE,
        borderWidth: 1,
        borderColor: 'transparent',
        justifyContent: 'center',
    },
    footerError: {
        alignItems: 'center',
        gap: theme.space.s4,
    },
    footerAction: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.button.secondary.tint,
    },
    footerNote: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    empty: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        paddingVertical: theme.space.s12,
    },
}));

export type WorkflowInvocationListProps = Readonly<{
    invocationStatusContext?: WorkflowInvocationLifecycleContext;
    invocations: readonly WorkflowRunInvocationIndexV1[];
    selectedInvocationId: string | null;
    /** The press event travels so the caller can return focus to this row later. */
    onSelectInvocation: (invocationId: string, event?: Parameters<React.ComponentProps<typeof HappierPressable>['onPress']>[0]) => void;
    /** Present only while the canonical reader reports another page. */
    onLoadMore?: () => void;
    loadingMore?: boolean;
    /**
     * That next page could not be loaded. Every loaded row stays and the cursor
     * is untouched; only the paging action becomes the reason plus a Retry that
     * asks for exactly the same page again.
     */
    loadMoreFailed?: boolean;
    loaded: boolean;
    resolveInvocationLabel?: (invocation: WorkflowRunInvocationIndexV1) => string | null;
    /** The shared occurrence projection distinguishes repeated steps without opening their content. */
    resolveInvocationOccurrenceLabel?: (invocation: WorkflowRunInvocationIndexV1) => string | null;
    /** The authored block kind for a row, so a held Wait-for-you step reads its own word. */
    resolveInvocationBlockKind?: (invocation: WorkflowRunInvocationIndexV1) => string | null;
    ListHeaderComponent?: React.ReactElement | null;
    ListFooterComponent?: React.ReactElement | null;
    contentContainerStyle?: StyleProp<ViewStyle>;
    listRef?: React.Ref<VirtualizedListRef>;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    testIDPrefix?: string;
}>;

export function WorkflowInvocationList(props: WorkflowInvocationListProps): React.ReactElement {
    const { theme } = useUnistyles();
    const testIDPrefix = props.testIDPrefix ?? 'workflow-invocations';
    const keyExtractor = React.useCallback((invocation: WorkflowRunInvocationIndexV1) => invocation.id, []);
    const extraData = React.useMemo(() => ({ selectedInvocationId: props.selectedInvocationId,
        invocationStatusContext: props.invocationStatusContext,
        resolveInvocationLabel: props.resolveInvocationLabel,
        resolveInvocationBlockKind: props.resolveInvocationBlockKind,
        resolveInvocationOccurrenceLabel: props.resolveInvocationOccurrenceLabel,
    }), [props.selectedInvocationId, props.invocationStatusContext, props.resolveInvocationLabel,
        props.resolveInvocationBlockKind, props.resolveInvocationOccurrenceLabel]);
    const renderInvocation = React.useCallback(({ item: invocation }: { item: WorkflowRunInvocationIndexV1 }) => {
        const selected = props.selectedInvocationId === invocation.id;
        const blockKind = props.resolveInvocationBlockKind?.(invocation) ?? null;
        const stateLabel = describeWorkflowInvocationLifecycle(invocation.lifecycle, { ...props.invocationStatusContext, blockKind }).label;
        const attempt = describeWorkflowInvocationAttempt(invocation.attempt);
        const displayLabel = props.resolveInvocationLabel?.(invocation) ?? t('workflows.contentUnavailable');
        const occurrenceLabel = props.resolveInvocationOccurrenceLabel?.(invocation) ?? null;
        const recordedTime = formatAsOfTime(Date.parse(invocation.createdAt));
        return (
            <HappierPressable
                testID={`${testIDPrefix}-row-${invocation.id}`}
                accessibilityRole="button"
                current={selected ? 'page' : undefined}
                accessibilityLabel={t('workflows.a11y.flowNode', {
                    node: [displayLabel, occurrenceLabel, attempt.retried ? attempt.label : null, recordedTime]
                        .filter((part) => part !== null).join(' · '),
                    state: stateLabel,
                })}
                onPress={(event) => props.onSelectInvocation(invocation.id, event)}
                style={(state) => [styles.row, selected ? styles.rowSelected : null, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
            >
                <View
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={styles.rail}
                />
                <View style={styles.identity}>
                    <Text style={[styles.label, selected ? styles.labelSelected : null]} numberOfLines={1}>
                        {displayLabel}
                    </Text>
                    {occurrenceLabel === null ? null : (
                        <Text testID={`${testIDPrefix}-occurrence-${invocation.id}`} style={styles.occurrence}>
                            {occurrenceLabel}
                        </Text>
                    )}
                </View>
                <View style={styles.trailing}>
                    <Text testID={`${testIDPrefix}-time-${invocation.id}`} style={styles.ordinal}>
                        {recordedTime}
                    </Text>
                    {attempt.retried ? (
                        <Text testID={`${testIDPrefix}-attempt-${invocation.id}`} style={styles.ordinal}>
                            {attempt.label}
                        </Text>
                    ) : null}
                    <WorkflowLifecycleStatus
                        testID={`${testIDPrefix}-state-${invocation.id}`}
                        lifecycle={invocation.lifecycle}
                        blockKind={blockKind}
                        context={props.invocationStatusContext}
                    />
                </View>
            </HappierPressable>
        );
    }, [props.invocationStatusContext, props.onSelectInvocation, props.resolveInvocationBlockKind, props.resolveInvocationLabel,
        props.resolveInvocationOccurrenceLabel, props.selectedInvocationId, testIDPrefix, theme.colors.border.focus]);

    const pagingFooter = props.onLoadMore === undefined ? null : (
        <View style={styles.footer}>
            {props.loadMoreFailed === true ? (
                // The rows above are unaffected; only this page is missing.
                <View
                    testID={`${testIDPrefix}-load-more-error`}
                    accessibilityRole="alert"
                    style={styles.footerError}
                >
                    <Text style={styles.footerNote}>{t('workflows.loadFailedBody')}</Text>
                    <HappierPressable
                        testID={`${testIDPrefix}-load-more-retry`}
                        accessibilityRole="button"
                        accessibilityLabel={t('workflows.retry')}
                        disabled={props.loadingMore === true}
                        onPress={props.onLoadMore}
                        style={(state) => [styles.footerTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    >
                        <Text style={styles.footerAction}>{t('workflows.retry')}</Text>
                    </HappierPressable>
                </View>
            ) : props.loadingMore === true ? (
                <Text testID={`${testIDPrefix}-loading-more`} style={styles.footerNote}>
                    {t('common.loading')}
                </Text>
            ) : (
                <HappierPressable
                    testID={`${testIDPrefix}-load-more`}
                    accessibilityRole="button"
                    onPress={props.onLoadMore}
                    style={(state) => [styles.footerTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                >
                    <Text style={styles.footerAction}>{t('workflows.run.loadMore')}</Text>
                </HappierPressable>
            )}
        </View>
    );

    return (
        <View accessibilityRole="list" style={styles.scroll}>
            <VirtualizedList
                ref={props.listRef}
                testID={testIDPrefix}
                style={styles.scroll}
                data={props.invocations}
                keyExtractor={keyExtractor}
                renderItem={renderInvocation}
                extraData={extraData}
                contentContainerStyle={[styles.list, props.contentContainerStyle]}
                onScroll={props.onScroll}
                scrollEventThrottle={32}
                ListHeaderComponent={props.ListHeaderComponent === null || props.ListHeaderComponent === undefined
                    ? null
                    : <View style={styles.listHeader}>{props.ListHeaderComponent}</View>}
                // A first page still in flight says so; it must not read as a
                // Run with no history. Once loaded, no rows means nothing has
                // started yet in this Run — not the collection's empty copy.
                ListEmptyComponent={props.loaded ? (
                    <Text testID={`${testIDPrefix}-empty`} style={styles.empty}>
                        {t('workflows.run.notStarted')}
                    </Text>
                ) : (
                    <Text testID={`${testIDPrefix}-loading`} style={styles.empty}>
                        {t('common.loading')}
                    </Text>
                )}
                ListFooterComponent={pagingFooter === null && props.ListFooterComponent === null
                    ? null
                    : (
                        <>
                            {pagingFooter}
                            {props.ListFooterComponent === null || props.ListFooterComponent === undefined
                                ? null
                                : <View style={styles.listFooter}>{props.ListFooterComponent}</View>}
                        </>
                    )}
            />
        </View>
    );
}
