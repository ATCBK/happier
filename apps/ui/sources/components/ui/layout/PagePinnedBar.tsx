import * as React from 'react';
import { View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useFloatingChromeClearance } from '@/components/ui/layout/useFloatingChromeClearance';

/**
 * A page's pinned action bar: a sibling below the page's scroll, never scrolled off, on the page
 * surface under a hairline. It owns how that bar clears the bottom of the screen, so no page does the
 * arithmetic itself:
 * - the phone's floating tab bar overlays the page, so the bar reserves its measured height (the same
 *   reservation `ItemList` makes for its last rows), unless the bar is inside a modal that covers it;
 * - with no such chrome the bar clears the system safe area instead.
 * Consumers pass the bar's contents, and `style` for a horizontal inset their surface calls for.
 */
export function PagePinnedBar(props: Readonly<Pick<ViewProps, 'testID' | 'children'> & { style?: StyleProp<ViewStyle> }>) {
    const { theme } = useUnistyles();
    const insets = useChromeSafeAreaInsets();
    const reserved = useFloatingChromeClearance();
    const paddingBottom = reserved > 0 ? theme.space.s12 + reserved : Math.max(theme.space.s12, insets.bottom);
    return (
        <View testID={props.testID} style={[styles.bar, props.style, { paddingBottom }]}>
            {props.children}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    bar: {
        paddingTop: theme.space.s12,
        paddingHorizontal: theme.space.s16,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
        backgroundColor: theme.colors.surface.base,
    },
}));
