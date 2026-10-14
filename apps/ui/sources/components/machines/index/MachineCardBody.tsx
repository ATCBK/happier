import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * The one machine card (MPG-14): the machine's mark, name and quiet tag, the line that says how it is,
 * then a fixed footer — what it is doing on the left, its one action (or a chevron) on the right. A card
 * never grows: every line holds its place whether or not it has words. All machines → Grid draws it;
 * plan 60's Machines widget draws the same body with its agents row and Update in the footer slots.
 * Plan 20's metric tiles join between the header and the footer when its summary lands.
 */
export const MACHINE_CARD_BODY_HEIGHT_PX = 116;
/** The same card with its metric tiles (plan 20's summary): the tiles take a fixed band between header and footer. */
export const MACHINE_CARD_BODY_WITH_TILES_HEIGHT_PX = 196;

export const MachineCardBody = React.memo(function MachineCardBody(props: Readonly<{
    mark: React.ReactNode;
    name: string;
    /** "This computer", "Running", the owner's name: who or what it is, quietly. */
    tag?: string | null;
    /** How the machine is, in one line ("Offline · last seen yesterday"). */
    line?: string | null;
    /** The metric tiles band (CPU · Memory · Disk), or why there is nothing to show; omitted: no band. */
    tiles?: React.ReactNode;
    /** What it is doing ("3 working · up 6 d"), or why it says nothing. */
    footerLeft?: React.ReactNode;
    /** Its one action; a chevron when the card itself is the action. */
    action?: React.ReactNode;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <View style={styles.card} testID={props.testID}>
            <View style={styles.header}>
                <View style={styles.mark}>{props.mark}</View>
                <View style={styles.identity}>
                    <View style={styles.titleLine}>
                        <Text numberOfLines={1} style={styles.name}>{props.name}</Text>
                        {props.tag ? <Text numberOfLines={1} style={styles.tag}>{props.tag}</Text> : null}
                    </View>
                    <Text numberOfLines={1} style={styles.line}>{props.line ?? ' '}</Text>
                </View>
            </View>
            {props.tiles !== undefined ? <View style={styles.tiles}>{props.tiles}</View> : null}
            <View style={styles.footer}>
                <View style={styles.footerLeft}>
                    {typeof props.footerLeft === 'string' || props.footerLeft === undefined || props.footerLeft === null
                        ? <Text numberOfLines={1} style={styles.footerText}>{props.footerLeft ?? ' '}</Text>
                        : props.footerLeft}
                </View>
                {props.action ?? <Icon name="caret-right" size={14} color={theme.colors.text.tertiary} />}
            </View>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    card: {
        flex: 1,
        justifyContent: 'space-between',
    },
    tiles: {
        height: MACHINE_CARD_BODY_WITH_TILES_HEIGHT_PX - MACHINE_CARD_BODY_HEIGHT_PX,
        marginTop: theme.space.s12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
        justifyContent: 'center',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s16,
    },
    mark: {
        width: 20,
        height: 20,
        marginTop: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    identity: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s2,
    },
    titleLine: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: theme.space.s8,
        minWidth: 0,
    },
    name: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
        flexShrink: 0,
        maxWidth: '75%',
    },
    tag: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        flexShrink: 1,
    },
    line: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        minHeight: 44,
        paddingHorizontal: theme.space.s16,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
    },
    footerLeft: {
        flex: 1,
        minWidth: 0,
    },
    footerText: {
        ...Typography.variant('meta'),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
}));
