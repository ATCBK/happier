import { HAPPIER_FRESHNESS_LINE_METRICS, HappierFreshnessLine, HappierPressable, resolveHappierFreshnessText } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { getPreferredLanguage, t } from '@/text';

import type { SurfaceStateAction } from './SurfaceStateCard';

const LINK_MIN_TARGET_PX = resolveMinimumInteractiveTargetSize(Platform.OS);

const SurfaceFreshnessOnSheetContext = React.createContext(false);

/** Hosts whose body already sits on a sheet or card (a widget body) render the line plain on it. */
export function SurfaceFreshnessOnSheetProvider(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    return <SurfaceFreshnessOnSheetContext.Provider value>{props.children}</SurfaceFreshnessOnSheetContext.Provider>;
}

/**
 * Stale content, told honestly (pane-states lab 0, "Stale"): the last-known content stays at full
 * strength and this one quiet line sits under the surface's header — as of when, why, and one Retry.
 *
 * It never sits over an empty body: a surface that has nothing retained is loading or failed and shows
 * `SurfaceStateCard` instead. Rows never dim. Render it only while the content is stale.
 */
export function SurfaceFreshnessLine(props: Readonly<{
    testID?: string;
    /** When the retained content was last read. Omit when the reason alone says it ("Reconnecting…"). */
    asOf?: number | null;
    /** Already-translated reason: "devbox isn't answering", "reconnecting to MacBook Pro…". */
    reason: string;
    /** A reconnect or refresh is in flight: a small ring replaces the glyph. */
    busy?: boolean;
    /** `warning` tints the strip when retained work needs attention. */
    tone?: 'neutral' | 'warning';
    /** The one recovery (Retry). */
    action?: SurfaceStateAction;
    animationEnabled?: boolean;
    /**
     * `chip`: the same facts as one inline status at a header's or tab bar's end (resources lab `.rs-live`):
     * "● Live", "Paused", "As of 10:42 · Checking…", "As of 10:42 · Retry". Its glyph is the `signal` dot
     * while nothing is behind, the ring while `busy`, else the clock of held content.
     */
    presentation?: 'line' | 'chip';
    /** Chip only: the steady state's dot, `live` (sampling) or `quiet` (paused, offline). */
    signal?: 'live' | 'quiet';
    /** Chip only: a quiet clause before the glyph ("Sampled only while you're looking"). */
    lead?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const onSheet = React.useContext(SurfaceFreshnessOnSheetContext);
    const chip = props.presentation === 'chip';
    const text = resolveHappierFreshnessText({
        asOf: props.asOf,
        reason: props.reason,
        formatAsOf: (time) => t('surfaceState.asOf', { time }),
        locale: getPreferredLanguage(),
    });
    return (
        <HappierFreshnessLine
            testID={props.testID}
            busy={props.busy}
            onSheet={onSheet}
            // The tint carries the warning; its edges stay ink hairlines (an amber rule read heavier than the words).
            colors={{ background: props.tone === 'warning' ? theme.colors.state.warning.background : theme.colors.surface.inset,
                border: theme.colors.border.default }}
            presentation={chip ? 'chip' : 'line'}
            lead={chip && props.lead ? (
                <Text testID={props.testID ? `${props.testID}-lead` : undefined} style={[stylesheet.text, stylesheet.lead]} numberOfLines={1}>{props.lead}</Text>
            ) : undefined}
            icon={chip && props.signal && !props.busy ? (
                <StatusDot
                    testID={props.testID ? `${props.testID}-signal` : undefined}
                    color={props.signal === 'live' ? theme.colors.state.success.foreground : theme.colors.text.tertiary}
                    size={HAPPIER_FRESHNESS_LINE_METRICS.chip.dotPx}
                />
            ) : props.busy ? (
                <ActivitySpinner
                    testID={props.testID ? `${props.testID}-spinner` : undefined}
                    size={HAPPIER_FRESHNESS_LINE_METRICS.glyphPx - 1}
                    color={theme.colors.text.tertiary}
                    animationEnabled={props.animationEnabled !== false}
                />
            ) : (
                <Icon
                    name={props.tone === 'warning' ? 'warning' : chip ? 'clock' : 'arrow-clockwise'}
                    size={HAPPIER_FRESHNESS_LINE_METRICS.glyphPx}
                    color={props.tone === 'warning' ? theme.colors.state.warning.foreground : theme.colors.text.tertiary}
                />
            )}
            action={props.action ? (
                <>
                {/* A chip reads as one phrase, "As of 10:42 · Retry" (lab `.rs-live`); the strip ends with its link instead. */}
                {chip && text ? <Text style={stylesheet.text} aria-hidden accessibilityElementsHidden importantForAccessibility="no">·</Text> : null}
                <HappierPressable
                    testID={props.action.testID ?? (props.testID ? `${props.testID}-action` : undefined)}
                    accessibilityRole="button"
                    accessibilityLabel={props.action.label}
                    hitSlop={chip ? 8 : 6}
                    disabled={props.action.disabled}
                    busy={props.action.busy}
                    onPress={props.action.onPress}
                    style={({ focused }) => [stylesheet.link, chip ? stylesheet.chipLink : null, focusRingStyle({ focused, color: theme.colors.border.focus })]}
                >
                    <Text style={stylesheet.linkLabel}>{props.action.label}</Text>
                </HappierPressable>
                </>
            ) : null}
        >
            <Text testID={props.testID ? `${props.testID}-text` : undefined} style={stylesheet.text} numberOfLines={chip ? 1 : 2}>
                {text}
            </Text>
        </HappierFreshnessLine>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    text: {
        ...Typography.default(),
        ...HAPPIER_FRESHNESS_LINE_METRICS.text,
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    link: {
        minHeight: Math.min(LINK_MIN_TARGET_PX, HAPPIER_FRESHNESS_LINE_METRICS.minHeightPx),
        justifyContent: 'center',
        paddingHorizontal: theme.space.s4,
    },
    // The tab's clause stands apart from the status it qualifies (lab `rp` H: clause, then "● Live").
    lead: {
        marginRight: theme.space.s6,
    },
    // In a chip the link keeps the chip's height (its press frame grows through hitSlop), so the chip does not
    // change height between "Live" and "As of 10:42 · Retry".
    chipLink: {
        minHeight: HAPPIER_FRESHNESS_LINE_METRICS.chip.minHeightPx,
        paddingHorizontal: theme.space.s2,
        borderRadius: theme.space.s4,
    },
    // The same inline recovery as a state line's (lab `.l12-fresh a`): ink and semibold.
    linkLabel: {
        ...Typography.default('semiBold'),
        ...HAPPIER_FRESHNESS_LINE_METRICS.text,
        color: theme.colors.text.primary,
    },
}));
