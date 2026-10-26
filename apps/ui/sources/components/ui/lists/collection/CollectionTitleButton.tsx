import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_LIST_METRICS, useHappierHitArea } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useIsTablet, usePresentationWindowDimensions } from '@/utils/platform/responsive';

import { shouldUseTouchCompactRow } from './CollectionRowContent';

/** The title fills the column's title row (lab S1) under every pointer; a finger reaches the touch target through the hit area. */
const TRIGGER_SIZE = HAPPIER_COLLECTION_LIST_METRICS.titleRowHeight;

/** The list title's anatomy: every space title (Sessions, Workflows, Discussions) and a filter's titled trigger (a Board). */
export const collectionTitleStyles = StyleSheet.create((theme) => ({
    // The list's title is its scope: "My work ⌄" opens the scope menu. It reads as a title (primary
    // text, semibold), not as a filter pill; the funnel appears only when the view is narrowed beyond
    // the default, so the list never looks inexplicably short.
    trigger: {
        minHeight: TRIGGER_SIZE,
        minWidth: TRIGGER_SIZE,
        flexShrink: 1,
        paddingHorizontal: theme.space.s6,
        // Optical alignment: the label, not the press fill, sits on the group labels' edge.
        marginLeft: -6,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: theme.space.s6,
    },
    triggerPressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    triggerLabel: {
        minWidth: 0,
        flexShrink: 1,
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
    },
    // A column that is a phone's whole page opens with the hero title, as the Inbox tab does (lab `clviews:recentP`).
    phoneTriggerLabel: {
        ...Typography.default('bold'),
        ...happierPageTextMetrics('heroTitle'),
    },
}));

/** The hit area of a title trigger drawn with `collectionTitleStyles.trigger`: the pressable forwards `hitSlop`, `onLayout` and renders `frame`. */
export function useCollectionTitleTriggerHitArea() {
    return useHappierHitArea({ restingStyle: () => collectionTitleStyles.trigger });
}

/**
 * A list's title as a control: the space's name in the title role with its chevron, opening the menu
 * or dialog its host owns (lab `clspaces`: the title names the space and opens spaces and filters).
 */
export const CollectionTitleButton = React.memo(function CollectionTitleButton(props: Readonly<{
    testID: string;
    label: string;
    accessibilityLabel: string;
    expanded: boolean;
    hasPopup: 'menu' | 'dialog';
    onPress: () => void;
    /** `page` (default): a column-as-page's title on a phone. `section`: under a page's own title, it stays a heading. */
    scale?: 'page' | 'section';
}>) {
    const styles = collectionTitleStyles;
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const { width: windowWidth } = usePresentationWindowDimensions();
    const phone = shouldUseTouchCompactRow({ isTablet, platform: Platform.OS, windowWidth });
    const hitArea = useCollectionTitleTriggerHitArea();
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityState={{ expanded: props.expanded }}
            aria-expanded={props.expanded}
            aria-haspopup={props.hasPopup}
            onPress={props.onPress}
            hitSlop={hitArea.hitSlop}
            onLayout={hitArea.onLayout}
            style={({ pressed }) => [styles.trigger, pressed ? styles.triggerPressed : null]}
        >
            {hitArea.frame}
            <Text numberOfLines={1} style={[styles.triggerLabel, phone && props.scale !== 'section' ? styles.phoneTriggerLabel : null]}>{props.label}</Text>
            <Icon name="caret-down" size={12} color={theme.colors.text.secondary} />
        </Pressable>
    );
});

