import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { HorizontalScrollableRow } from '@/components/ui/scroll/HorizontalScrollableRow';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { Text } from '@/components/ui/text/Text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';

export type EditorAccessoryBarProps = Readonly<{
    children: React.ReactNode;
    variant?: 'panel' | 'inline';
    testID?: string;
}>;

/** Shared editor row chrome; native panels keep the existing keyboard-sticky owner. */
export function EditorAccessoryBar(props: EditorAccessoryBarProps) {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const isInline = props.variant === 'inline';
    const content = <HorizontalScrollableRow
        testID={props.testID ? `${props.testID}:scroll` : undefined}
        contentTestID={props.testID ? `${props.testID}:scroll-content` : undefined}
        fadeColor={isInline ? theme.colors.surface.base : theme.colors.surface.inset}
        indicatorColor={theme.colors.text.secondary}
        contentStyle={isInline ? stylesheet.scrollContentInline : stylesheet.scrollContent}
    >
        {props.children}
    </HorizontalScrollableRow>;

    if (isInline) return <View testID={props.testID} accessibilityRole="toolbar" style={stylesheet.inlineRoot}>
        {content}
    </View>;

    const bar = <View testID={props.testID} accessibilityRole="toolbar"
        style={[stylesheet.bar, { backgroundColor: paintColor(theme.colors.surface.inset, 'transparent') }]}>
        {content}
    </View>;
    return Platform.OS === 'web' ? bar : <KeyboardStickyFooter>{bar}</KeyboardStickyFooter>;
}

export type EditorAccessoryChipProps = Readonly<{
    icon: IconName;
    label: string;
    onPress: () => void;
    selected?: boolean;
    disabled?: boolean;
    badge?: string;
    testID?: string;
}>;

/** A press callback, not an editor command owner: hosts bind their existing handle or Save action. */
export function EditorAccessoryChip(props: EditorAccessoryChipProps) {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const selected = props.selected === true;
    const foreground = selected ? theme.colors.state.active.foreground : theme.colors.text.secondary;
    return <Pressable
        testID={props.testID}
        accessibilityRole="button"
        accessibilityLabel={props.label}
        accessibilityState={props.selected === undefined && props.disabled === undefined ? undefined : {
            ...(props.selected === undefined ? {} : { selected }),
            ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
        }}
        aria-pressed={props.selected}
        disabled={props.disabled}
        hitSlop={6}
        onPress={props.onPress}
        style={({ pressed }) => [stylesheet.chip, {
            backgroundColor: paintColor(selected ? theme.colors.state.active.background : theme.colors.surface.base),
            borderColor: selected ? theme.colors.state.active.border : theme.colors.border.default,
            opacity: pressed ? motionTokens.press.opacity : 1,
        }]}
    >
        <Icon name={props.icon} size={16} color={foreground} />
        {props.badge ? <Text style={[stylesheet.badge, { color: foreground }]} allowFontScaling={false}>
            {props.badge}
        </Text> : null}
    </Pressable>;
}

// Mechanical extraction of the Markdown toolbar's existing geometry and paint.
// The phone-specific code-key inventory and composition are supplied by its host.
const stylesheet = StyleSheet.create((theme) => ({
    bar: {
        backgroundColor: theme.colors.surface.inset,
        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderTopColor: theme.colors.border.default,
    },
    scrollContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    scrollContentInline: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 0,
        paddingVertical: 0,
    },
    inlineRoot: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
    },
    chip: {
        width: 34,
        height: 34,
        borderRadius: 9,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
    },
    badge: {
        position: 'absolute',
        right: 4,
        bottom: 3,
        fontSize: 9,
        fontWeight: '700',
        lineHeight: 10,
    },
}));
