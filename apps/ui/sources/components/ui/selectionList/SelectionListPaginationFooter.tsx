import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { selectionListTestId } from './_shared';
import type { SelectionListPagination } from './_types';
import {
    buildSelectionListSectionGroupA11yProps,
    type SelectionListA11yPattern,
} from './buildSelectionListOptionA11yProps';

const styles = StyleSheet.create((theme) => ({
    status: {
        minHeight: 52,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: theme.space.s8,
    },
    statusText: {
        color: theme.colors.text.secondary,
    },
    // A coverage or status sentence closing the rows: the rows' edge, meta type, like the in-list status lines.
    edgeStatus: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s8,
        alignItems: 'flex-start',
    },
    edgeStatusText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    error: {
        paddingTop: theme.space.s8,
    },
    errorText: {
        color: theme.colors.text.secondary,
        paddingHorizontal: theme.space.s16,
        paddingBottom: theme.space.s4,
    },
}));

export function SelectionListPaginationFooter(props: Readonly<{
    pagination: SelectionListPagination;
    rootTestID?: string;
    measureMode?: boolean;
    a11yPattern: SelectionListA11yPattern;
    onRetry: () => void;
}>): React.ReactElement | null {
    const measureMode = props.measureMode === true;
    const identityProps = measureMode
        ? {
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants' as const,
            pointerEvents: 'none' as const,
            'aria-hidden': true,
        }
        : null;
    const listboxGroupA11y = measureMode
        ? null
        : buildSelectionListSectionGroupA11yProps({ pattern: props.a11yPattern });
    const wrapListboxSupplement = (content: React.ReactElement): React.ReactElement => (
        listboxGroupA11y === null
            ? content
            : <View role="group" {...listboxGroupA11y}>{content}</View>
    );

    if (props.pagination.loadingMore) {
        return wrapListboxSupplement(
            <View
                testID={measureMode ? undefined : selectionListTestId(props.rootTestID, 'pagination', 'loading')}
                style={styles.status}
                accessibilityRole={measureMode ? undefined : 'text'}
                accessibilityLabel={measureMode ? undefined : props.pagination.loadingLabel}
                accessibilityLiveRegion={measureMode ? undefined : 'polite'}
                {...(measureMode ? {} : ({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>))}
                {...(identityProps ?? {})}
            >
                <ActivitySpinner size="small" />
                <Text style={styles.statusText}>{props.pagination.loadingLabel}</Text>
            </View>
        );
    }

    if (props.pagination.error) {
        return wrapListboxSupplement(
            <View
                testID={measureMode ? undefined : selectionListTestId(props.rootTestID, 'pagination', 'error')}
                style={styles.error}
                accessibilityRole={measureMode ? undefined : 'alert'}
                accessibilityLiveRegion={measureMode ? undefined : 'polite'}
                {...(measureMode ? {} : ({ role: 'alert', 'aria-live': 'polite' } as Record<string, unknown>))}
                {...(identityProps ?? {})}
            >
                <Text style={styles.errorText}>{props.pagination.error}</Text>
                {props.pagination.onRetry ? (
                    <Item
                        testID={measureMode ? undefined : selectionListTestId(props.rootTestID, 'pagination', 'retry')}
                        title={props.pagination.retryLabel}
                        onPress={props.onRetry}
                        accessibilityLabel={props.pagination.retryLabel}
                    />
                ) : null}
            </View>
        );
    }

    if (props.pagination.hasMore) {
        return wrapListboxSupplement(
            <>
                {props.pagination.moreNotice ? (
                    <View
                        testID={measureMode ? undefined : selectionListTestId(props.rootTestID, 'pagination', 'more-notice')}
                        style={styles.edgeStatus}
                        accessibilityRole={measureMode ? undefined : 'text'}
                        accessibilityLiveRegion={measureMode ? undefined : 'polite'}
                        {...(measureMode ? {} : ({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>))}
                        {...(identityProps ?? {})}
                    >
                        <Text style={styles.edgeStatusText}>{props.pagination.moreNotice}</Text>
                    </View>
                ) : null}
                <Item
                    testID={measureMode ? undefined : selectionListTestId(props.rootTestID, 'pagination', 'more')}
                    title={props.pagination.moreLabel}
                    onPress={props.pagination.onEndReached}
                    accessibilityLabel={props.pagination.moreLabel}
                    {...(identityProps ?? {})}
                />
            </>,
        );
    }

    // A list whose finish has nothing to say (an empty label) simply ends.
    if (props.pagination.endReachedLabel === '') return null;
    const edge = props.pagination.endReachedPlacement === 'edge';

    return wrapListboxSupplement(
        <View
            testID={measureMode ? undefined : selectionListTestId(props.rootTestID, 'pagination', 'end')}
            style={edge ? styles.edgeStatus : styles.status}
            accessibilityRole={measureMode ? undefined : 'text'}
            accessibilityLiveRegion={measureMode ? undefined : 'polite'}
            {...(measureMode ? {} : ({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>))}
            {...(identityProps ?? {})}
        >
            <Text style={edge ? styles.edgeStatusText : styles.statusText}>{props.pagination.endReachedLabel}</Text>
        </View>
    );
}
