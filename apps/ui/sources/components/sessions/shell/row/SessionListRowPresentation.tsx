import * as React from 'react';
import { Platform, useWindowDimensions, View, type LayoutChangeEvent, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { Text, type AppTextProps } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useIsTablet } from '@/utils/platform/responsive';

import {
    SESSION_LIST_ROW_CORNER_RADIUS,
    SESSION_LIST_ROW_IDENTITY_METRICS,
    SESSION_LIST_ROW_WIDTH_METRICS,
    SESSION_LIST_ROW_SELECTION_RADIUS,
    resolveSessionListRowStatusTextMetrics,
    resolveSessionListRowTitleTextMetrics,
    shouldUseReadablePhoneMinimalSessionRow,
    type SessionListRowDensity,
} from '../resolveSessionListDensityViewState';
import {
    SESSION_LIST_ROW_HEIGHT_COMPACT,
    SESSION_LIST_ROW_HEIGHT_DEFAULT,
    SESSION_LIST_ROW_HEIGHT_MINIMAL,
    SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_PHONE,
} from '../sessionListRowHeights';


type RowDensityProps = Readonly<{
    density: SessionListRowDensity;
    readableNativePhoneMinimal?: boolean;
    textScale?: number;
}>;

const styles = StyleSheet.create((theme) => ({
    row: {
        height: SESSION_LIST_ROW_HEIGHT_DEFAULT,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: SESSION_LIST_ROW_WIDTH_METRICS.default.paddingPx,
        backgroundColor: theme.colors.surface.base,
        borderLeftWidth: SESSION_LIST_ROW_WIDTH_METRICS.borderPx,
        borderRightWidth: SESSION_LIST_ROW_WIDTH_METRICS.borderPx,
        borderColor: theme.colors.surface.base,
    },
    first: {
        borderTopLeftRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderTopRightRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderTopWidth: 2,
    },
    last: {
        borderBottomLeftRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderBottomRightRadius: SESSION_LIST_ROW_CORNER_RADIUS,
        borderBottomWidth: 2,
    },
    separator: { borderBottomWidth: 1, borderBottomColor: theme.colors.border.default },
    compact: { height: SESSION_LIST_ROW_HEIGHT_COMPACT, paddingHorizontal: theme.space.s12 },
    minimal: { height: SESSION_LIST_ROW_HEIGHT_MINIMAL, paddingHorizontal: theme.space.s8 },
    minimalNativePhone: { height: SESSION_LIST_ROW_HEIGHT_MINIMAL_NATIVE_PHONE },
    // The open row is a rounded fill inside its group's sheet, the sheet's paper showing around it.
    selected: {
        backgroundColor: theme.colors.surface.selected,
        borderColor: theme.colors.surface.base,
        borderRadius: SESSION_LIST_ROW_SELECTION_RADIUS,
    },
    identity: {
        position: 'relative',
        width: SESSION_LIST_ROW_IDENTITY_METRICS.default.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.default.slotSize,
        alignItems: 'center',
        justifyContent: 'center',
    },
    identityCompact: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize,
    },
    identityMinimal: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.minimal.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.minimal.slotSize,
    },
    identityMinimalNativePhone: {
        width: SESSION_LIST_ROW_IDENTITY_METRICS.minimalNativePhone.slotSize,
        height: SESSION_LIST_ROW_IDENTITY_METRICS.minimalNativePhone.slotSize,
    },
    content: { flex: 1, marginLeft: SESSION_LIST_ROW_WIDTH_METRICS.default.contentMarginPx, justifyContent: 'center' },
    contentCompact: { marginLeft: theme.space.s12 },
    contentMinimal: { marginLeft: 0 },
    contentMinimalWithIdentity: { marginLeft: theme.space.s8 },
    titleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 1, gap: theme.space.s6 },
    title: {
        ...resolveSessionListRowTitleTextMetrics({ density: 'default', readableNativePhoneMinimal: false }),
        flex: 1,
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    titleCompact: resolveSessionListRowTitleTextMetrics({ density: 'compact', readableNativePhoneMinimal: false }),
    titleMinimal: resolveSessionListRowTitleTextMetrics({ density: 'minimal', readableNativePhoneMinimal: false }),
    titleMinimalNativePhone: resolveSessionListRowTitleTextMetrics({ density: 'minimal', readableNativePhoneMinimal: true }),
    emphasized: { ...Typography.default('semiBold') },
    subtitle: { ...Typography.variant('meta'), color: theme.colors.text.secondary,   },
    subtitleCompact: resolveSessionListRowStatusTextMetrics('compact'),
    subtitleMinimal: resolveSessionListRowStatusTextMetrics('minimal'),
    // The slot yields before the title does: a long status word truncates at two fifths of the row so two Runs or
    // Sessions with different names never collapse to the same clipped title.
    trailing: { marginLeft: theme.space.s8, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 1, minWidth: 0, maxWidth: `${SESSION_LIST_ROW_WIDTH_METRICS.default.trailingMaxShare * 100}%` as `${number}%` },
    // The row's press target: everything left of the trailing slot, the row's full height.
    pressTarget: { flex: 1, minWidth: 0, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center' },
}));

/** A minimal row on a phone-width window is drawn at the readable phone size, whichever kind of row it is. */
export function useReadableNativePhoneMinimalRow(minimal: boolean): boolean {
    const isTablet = useIsTablet();
    const { width: windowWidth } = useWindowDimensions();
    return minimal && shouldUseReadablePhoneMinimalSessionRow({ isTablet, platform: Platform.OS, windowWidth });
}

/** The real row's geometry, with no session, settings, activity or action subscriptions. */
export function SessionListRowPresentation(props: RowDensityProps & Readonly<{
    first?: boolean;
    last?: boolean;
    selected?: boolean;
    separator?: boolean;
    identity?: React.ReactNode;
    /** Independent leading controls, such as the reports disclosure, stay outside navigation. */
    leading?: React.ReactNode;
    title: React.ReactNode;
    children?: React.ReactNode;
    trailing?: React.ReactNode;
    trailingProps?: Omit<ViewProps, 'style' | 'children'>;
    /**
     * The live row supplies its Pressable as the press target for the identity and text; static
     * previews use a View. The trailing slot is its sibling, never its child: on the web a button
     * role renders a `<button>`, and the trailing actions (tag, pin, ⋯) are buttons of their own.
     */
    renderContainer?: (content: React.ReactNode, style: StyleProp<ViewStyle>) => React.ReactElement;
    /** Measures the whole row (the trailing slot included). */
    onLayout?: (event: LayoutChangeEvent) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const selected = props.selected === true;
    // A row's state is its word and glyph in the trailing slot (lab `convo-N4`): Session and Run rows
    // alike, never a tinted or ringed row. Only the open row takes a fill.
    const baseColor = selected ? theme.colors.surface.selected : theme.colors.surface.base;
    const compact = props.density !== 'default';
    const minimal = props.density === 'minimal';
    const textScale = typeof props.textScale === 'number' && Number.isFinite(props.textScale)
        ? Math.max(1, props.textScale)
        : 1;
    const largeText = textScale > 1.1;
    const baseRowHeight = props.density === 'default'
        ? SESSION_LIST_ROW_HEIGHT_DEFAULT
        : props.density === 'minimal'
            ? SESSION_LIST_ROW_HEIGHT_MINIMAL
            : SESSION_LIST_ROW_HEIGHT_COMPACT;
    const scaledRowHeight = largeText ? Math.ceil(baseRowHeight * Math.min(textScale, 2.5)) : baseRowHeight;
    const hasIdentity = props.identity != null;
    const rowStyle = [
        styles.row,
        props.first ? styles.first : null,
        props.last ? styles.last : null,
        compact ? styles.compact : null,
        minimal ? styles.minimal : null,
        props.readableNativePhoneMinimal ? styles.minimalNativePhone : null,
        props.selected ? styles.selected : null,
        props.separator ? styles.separator : null,
        // Keep the incumbent geometry at normal scale. Large text may grow so the
        // title and context remain readable instead of being clipped by a fixed height.
        largeText ? { minHeight: scaledRowHeight, height: undefined } : null,
        {
            backgroundColor: materialColor(baseColor, selected ? baseColor : 'transparent'),
            borderColor: materialColor(theme.colors.surface.base, 'transparent'),
        },
    ];
    const pressContent = <>
        {hasIdentity ? <View style={[
            styles.identity,
            compact ? styles.identityCompact : null,
            minimal ? styles.identityMinimal : null,
            props.readableNativePhoneMinimal ? styles.identityMinimalNativePhone : null,
        ]}>{props.identity}</View> : null}
        <View style={[
            styles.content,
            compact ? styles.contentCompact : null,
            minimal ? styles.contentMinimal : null,
            minimal && hasIdentity ? styles.contentMinimalWithIdentity : null,
        ]}>
            <View style={styles.titleRow}>{props.title}</View>
            {props.children}
        </View>
    </>;
    const trailing = <View {...props.trailingProps} style={styles.trailing}>{props.trailing}</View>;
    return (
        <View style={rowStyle} onLayout={props.onLayout}>
            {props.leading}
            {props.renderContainer ? props.renderContainer(pressContent, styles.pressTarget) : pressContent}
            {trailing}
        </View>
    );
}

export function SessionListRowTitle({ density, readableNativePhoneMinimal, textScale, emphasized, color, style, ...props }:
    RowDensityProps & AppTextProps & Readonly<{ emphasized?: boolean; color?: string }>): React.ReactElement {
    return <Text {...props} numberOfLines={textScale && textScale > 1.1 ? 2 : 1} style={[
        styles.title,
        density !== 'default' ? styles.titleCompact : null,
        density === 'minimal' ? styles.titleMinimal : null,
        readableNativePhoneMinimal ? styles.titleMinimalNativePhone : null,
        emphasized ? styles.emphasized : null,
        color ? { color } : null,
        style,
    ]} />;
}

export function SessionListRowSubtitle({ density, readableNativePhoneMinimal, textScale, style, ...props }:
    RowDensityProps & AppTextProps): React.ReactElement {
    return <Text {...props} numberOfLines={textScale && textScale > 1.1 ? 2 : 1} style={[
        styles.subtitle,
        density !== 'default' && !readableNativePhoneMinimal ? styles.subtitleCompact : null,
        density === 'minimal' && !readableNativePhoneMinimal ? styles.subtitleMinimal : null,
        style,
    ]} />;
}

/**
 * Content that belongs to the compact row above it (a Bot's readiness in the roster): it starts on the
 * row's title edge, past the identity mark, so it reads as part of that row rather than a new one.
 */
export function SessionListCompactRowFooter(props: Readonly<{
    children: React.ReactNode;
    /** The row's divider moves below its footer, so the pair reads as one row. */
    separator?: boolean;
    testID?: string;
}>) {
    return (
        <View
            testID={props.testID}
            style={[compactRowFooterStyles.footer, props.separator ? compactRowFooterStyles.separator : null]}
        >
            {props.children}
        </View>
    );
}

const compactRowFooterStyles = StyleSheet.create((theme) => ({
    footer: {
        // The compact row's side border + padding, identity slot and content gap.
        paddingLeft: 2 + theme.space.s12 + SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize + theme.space.s12,
        paddingRight: 2 + theme.space.s12,
        // Tucks under the row's own last line instead of starting a new row's rhythm.
        marginTop: -theme.space.s8,
        paddingBottom: theme.space.s10,
    },
    separator: { borderBottomWidth: 1, borderBottomColor: theme.colors.border.default },
}));
