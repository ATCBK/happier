import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

/**
 * Layout for the session instrument strip. One 28-high row: connection/working
 * status pinned left, a flexible spacer, then the right-aligned instrument
 * cluster (context gauge · quota ring · git ± · extension badges · permission)
 * and the host's trailing actions. When they do not fit on one line (a phone),
 * the row wraps instead of running past the edge: whatever no longer fits moves
 * to its own right-aligned line, so a status badge keeps its row whole.
 */
export const instrumentStripStyles = StyleSheet.create((theme) => ({
    root: {
        minHeight: 28,
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        alignItems: 'center',
        rowGap: 6,
        // The line starts on the card's content edge (0.2): its dot sits over the field's first
        // letter and the chips' first glyph, and the right cluster ends where the card's content does.
        paddingHorizontal: theme.margins.xl,
    },
    rootCollapsed: {
        minHeight: 0,
    },
    connectionGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
        gap: 6,
    },
    connectionDot: {
        marginRight: 0,
    },
    connectionText: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        flexShrink: 1,
        minWidth: 0,
    },
    /** The sentence of a line whose action is a name: the sentence keeps its width and the name gives way. */
    connectionTextKept: {
        flexShrink: 0,
    },
    /** A name-labelled action shrinks (its text ellipsizes) before the sentence does. */
    connectionActionHost: {
        flexShrink: 1,
        minWidth: 0,
    },
    /** The tooltip host around a line that carries a detail: it shrinks like the text it wraps. */
    connectionTextHost: {
        flexShrink: 1,
        minWidth: 0,
    },
    /** The guard's countdown inside the line: its own ink weight, tabular so the digits never shift. */
    connectionCountdown: {
        fontSize: 12,
        fontWeight: '600',
        fontVariant: ['tabular-nums'],
    },
    spacer: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 8,
    },
    cluster: {
        flexDirection: 'row',
        alignItems: 'center',
        // Only shrinks when it is alone on a line narrower than itself; a long badge then wraps its words.
        flexShrink: 1,
        minWidth: 0,
        gap: 10,
    },
    trailingActions: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: 10,
    },
    instrumentSlot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    /** The opt-in name beside a gauge ("Context", "5-hour"): smaller than the values. */
    instrumentLabelText: {
        ...Typography.pillLabel(),
        color: theme.colors.text.secondary,
    },
    instrumentValueText: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    permissionChip: {
        flexShrink: 0,
    },
    permissionText: {
        fontSize: 12,
        fontVariant: ['tabular-nums'],
    },
    overflowChip: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 20,
        minWidth: 28,
        paddingHorizontal: 6,
        borderRadius: 999,
    },
    overflowChipText: {
        fontSize: 13,
        lineHeight: 13,
        color: theme.colors.text.secondary,
    },
    overflowPopover: {
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 14,
        minWidth: 220,
    },
    overflowPopoverRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    overflowPopoverRowLabel: {
        fontSize: 13,
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
}));
