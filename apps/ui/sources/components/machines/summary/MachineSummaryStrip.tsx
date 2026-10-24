import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { CapacityBar, StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { CapacityRing } from '@/components/ui/progress/CapacityRing';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { MachineResourceAvailability } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { t } from '@/text';

import {
    buildMachineSummaryInstruments,
    fitMachineSummaryMetrics,
    resolveMachineResourceToneColor,
    type MachineSummaryInstrument,
    type MachineSummaryMetric,
    type MachineSummaryStyle,
} from './machineSummaryStripModel';

/**
 * Where the strip stands: `under` a row's name (popover, phone list; fixed value slots), `inline` on the
 * name's line (the machine list column; instruments without figures), one metric per table `cells`,
 * a card's `tiles`, a static `preview` (the style tiles) and the one-line memory `fact` (New Session).
 */
export type MachineSummaryStripLayout = 'under' | 'inline' | 'cells' | 'tiles' | 'preview' | 'fact';

/** The instrument widths the layouts draw (the figure slots are tabular and fixed so live values never shift). */
const LINE_WIDTH = { under: 44, inline: 28, cells: 56, tiles: 120, preview: 36, fact: 0 } as const;
const LINE_HEIGHT = { under: 12, inline: 10, cells: 14, tiles: 24, preview: 10, fact: 0 } as const;
const RING_SIZE = { under: 16, inline: 14, cells: 16, tiles: 28, preview: 14, fact: 0 } as const;
/** A card's rings stand as instruments (lab `rw` V): the ring, its figure, then its name, centred. */
const RING_FIGURE_SIZE = 52;
/** The lab's ring (`rw` V) draws its arc at about a tenth of its diameter, on a track one step up from a hairline. */
const RING_FIGURE_STROKE = 5;
/**
 * The list column's row (lab `rm` R): every chosen instrument stands on the name's line as a small drawing without
 * figures. Numbers are the one style with no drawing, so it keeps the name's line with a single figure (the metric in
 * trouble first, else the first chosen).
 */
const INLINE_NUMBERS_CAPACITY = 1;
/** The room one `under` instrument takes by style: its drawing, the gap and its figure slot. */
const UNDER_FIGURE_SLOT = 44;
const UNDER_UNIT_WIDTH: Readonly<Record<MachineSummaryStyle, number>> = {
    numbers: UNDER_FIGURE_SLOT,
    rings: RING_SIZE.under + 4 + UNDER_FIGURE_SLOT,
    bars: LINE_WIDTH.under + 4 + UNDER_FIGURE_SLOT,
    sparklines: LINE_WIDTH.under + 4 + UNDER_FIGURE_SLOT,
};

/**
 * How many instruments the `under` row has room for at its measured width (upstream's density steps, MPG-20):
 * the row sits under a name in a block that gives it the whole width (the popover, a phone list line, a card),
 * so its own width is the room. Calm metrics yield first and a toned one is never dropped (`fitMachineSummaryMetrics`);
 * before the first measurement every chosen metric shows. At least one always fits.
 */
export function machineSummaryUnderCapacity(style: MachineSummaryStyle, availableWidth: number | null, gap: number): number {
    if (availableWidth === null) return Number.POSITIVE_INFINITY;
    return Math.max(1, Math.floor((availableWidth + gap) / (UNDER_UNIT_WIDTH[style] + gap)));
}

export type MachineSummaryStripProps = Readonly<{
    availability: MachineResourceAvailability | null;
    style: MachineSummaryStyle;
    metrics: readonly MachineSummaryMetric[];
    layout: MachineSummaryStripLayout;
    testID?: string;
}>;

/**
 * The single owner of a machine's resource summary (MPG-20). Values, tone and lines are plan 20's: CPU is
 * percent in use, memory and disk are what is free (bars and rings fill by what is used, R9), a metric in
 * trouble takes its word or figure in tone, calm is ink. Unmeasured values show nothing, never "0"; a held
 * summary dims one step when stale. The strip keeps its height whatever it holds, so rows never move.
 */
export const MachineSummaryStrip = React.memo(function MachineSummaryStrip(props: MachineSummaryStripProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const summary = props.availability?.kind === 'reporting' ? props.availability.summary : null;
    const instruments = React.useMemo(() => (summary ? buildMachineSummaryInstruments(summary) : null), [summary]);
    const [underWidth, setUnderWidth] = React.useState<number | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const visibleWidth = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
        if (visibleWidth === null) return;
        const width = Math.round(visibleWidth);
        setUnderWidth(current => (current === width ? current : width));
    }, []);
    if (props.metrics.length === 0) return null;
    if (props.layout === 'fact') return <MachineMemoryFact instruments={instruments} testID={props.testID} />;
    // Held in a const so the narrowing reaches the instruments drawn below.
    const layout = props.layout;
    const shown = props.layout === 'inline' && props.style === 'numbers'
        ? fitMachineSummaryMetrics(props.metrics, instruments, INLINE_NUMBERS_CAPACITY)
        : props.layout === 'under'
            ? fitMachineSummaryMetrics(props.metrics, instruments, machineSummaryUnderCapacity(props.style, underWidth, theme.space.s12))
            : props.metrics;
    // A failed watch or read keeps its values, one step dimmer: the freshness line says why (M-15).
    const stale = props.availability?.kind === 'reporting' && (props.availability.freshness === 'stale' || props.availability.readStatus !== undefined);
    const accessibilityLabel = describeMachineSummary(instruments, shown);
    return (
        <View
            testID={props.testID}
            accessible
            accessibilityLabel={accessibilityLabel}
            onLayout={props.layout === 'under' ? onLayout : undefined}
            style={[props.layout === 'tiles' ? styles.tiles : styles.row, props.layout === 'inline' ? styles.inlineRow : null,
                props.layout === 'under' ? styles.underRow : null, stale ? styles.stale : null]}
        >
            {shown.map(metric => (
                <MachineSummaryInstrumentView
                    key={metric}
                    metric={metric}
                    instrument={instruments?.[metric] ?? null}
                    style={props.style}
                    layout={layout}
                    // One caption names the instruments; labels return only where one or four metrics show (MPG-20).
                    labelled={props.layout === 'tiles' || ((props.layout === 'under' || props.layout === 'preview') && (shown.length === 1 || shown.length === 4))}
                    neverSampled={props.availability?.kind === 'never_sampled'
                        || props.availability?.kind === 'reporting' && !instruments?.[metric]?.figure}
                    color={theme.colors.text.secondary}
                />
            ))}
        </View>
    );
});

/** "CPU 12 % in use, memory 71 GB free, disk 412 GB free": every shown metric, exact (MPG-31). */
export function describeMachineSummary(
    instruments: Readonly<Record<MachineSummaryMetric, MachineSummaryInstrument>> | null,
    metrics: readonly MachineSummaryMetric[],
): string {
    if (!instruments) return metrics.map(metric => t(METRIC_TITLE_KEYS[metric])).join(', ');
    return metrics.map(metric => instruments[metric].exact ?? t('machineSummary.unmeasured', { metric: t(METRIC_TITLE_KEYS[metric]) })).join(', ');
}

const METRIC_TITLE_KEYS = {
    cpu: 'machineSummary.metrics.cpu',
    memory: 'machineSummary.metrics.memory',
    disk: 'machineSummary.metrics.disk',
    network: 'machineSummary.metrics.network',
} as const satisfies Record<MachineSummaryMetric, string>;

export function machineSummaryMetricTitle(metric: MachineSummaryMetric): string {
    return t(METRIC_TITLE_KEYS[metric]);
}

const MachineSummaryInstrumentView = React.memo(function MachineSummaryInstrumentView(props: Readonly<{
    metric: MachineSummaryMetric;
    instrument: MachineSummaryInstrument | null;
    style: MachineSummaryStyle;
    layout: Exclude<MachineSummaryStripLayout, 'fact'>;
    labelled: boolean;
    neverSampled: boolean;
    color: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { instrument, layout } = props;
    const tone = instrument?.tone ?? 'calm';
    const toneColor = resolveMachineResourceToneColor(tone, theme.colors);
    const inkColor = tone === 'calm' ? props.color : toneColor;
    const showFigure = (layout !== 'inline' || props.style === 'numbers') && (props.style !== 'rings' || layout === 'tiles' || layout === 'cells');
    const figure = instrument?.figure ?? (props.neverSampled ? '–' : null);
    if (layout === 'tiles' && props.style === 'rings' && props.metric !== 'network') {
        const ring = (
            <View style={styles.ringFigure}>
                <CapacityRing ratio={instrument?.used ?? 0} color={inkColor} trackColor={theme.colors.border.default}
                    size={RING_FIGURE_SIZE} strokeWidth={RING_FIGURE_STROKE} />
                <MachineSummaryRingValue metric={props.metric} figure={figure} color={toneColor} />
                <Text numberOfLines={1} style={styles.label}>{machineSummaryMetricTitle(props.metric)}</Text>
            </View>
        );
        // The tooltip's host takes the ring's column, so the rings spread over the card (loading and loaded alike).
        return instrument?.exact ? <Tooltip label={instrument.exact} style={styles.ringTile}>{ring}</Tooltip> : ring;
    }
    const drawn = renderInstrument({ ...props, inkColor, trackColor: theme.colors.border.subtle });
    const body = (
        <View style={layout === 'tiles' ? styles.tile : styles.instrument}>
            {props.labelled ? <Text numberOfLines={1} style={styles.label}>{machineSummaryMetricTitle(props.metric)}</Text> : null}
            {layout === 'tiles' ? (
                <>
                    <Text numberOfLines={1} style={[styles.tileFigure, { color: toneColor }]}>{figure ?? ' '}</Text>
                    <View style={styles.tileInstrument}>{drawn}</View>
                </>
            ) : (
                <>
                    {drawn}
                    {showFigure ? (
                        <Text numberOfLines={1} style={[styles.figure, layout === 'under' || layout === 'preview' ? styles.figureSlot : null, { color: toneColor }]}>
                            {figure ?? ' '}
                        </Text>
                    ) : null}
                </>
            )}
        </View>
    );
    // The exact reading on hover and keyboard focus (R9); the strip's own name already says it to screen readers.
    return instrument?.exact && layout !== 'preview' ? <Tooltip label={instrument.exact}>{body}</Tooltip> : body;
});

/**
 * "71 GB free" under a ring: the number at the figure's weight, its unit quieter beside it. A word in tone
 * ("Critical") and a percentage stand alone; an unmeasured value keeps its line, empty.
 */
function MachineSummaryRingValue(props: Readonly<{ metric: MachineSummaryMetric; figure: string | null; color: string }>) {
    const styles = stylesheet;
    const match = props.figure ? /^([\d.,]+)\s+(\S+)$/u.exec(props.figure) : null;
    const free = props.metric === 'memory' || props.metric === 'disk';
    return (
        <View style={styles.ringValue}>
            <Text numberOfLines={1} style={[styles.ringNumber, { color: props.color }]}>{match ? match[1] : props.figure ?? ' '}</Text>
            {match ? (
                <Text numberOfLines={1} style={styles.ringUnit}>
                    {free ? t('machines.widgets.body.vitals.unitFree', { unit: match[2]! }) : match[2]}
                </Text>
            ) : null}
        </View>
    );
}

function renderInstrument(props: Readonly<{
    metric: MachineSummaryMetric;
    instrument: MachineSummaryInstrument | null;
    style: MachineSummaryStyle;
    layout: Exclude<MachineSummaryStripLayout, 'fact'>;
    inkColor: string;
    trackColor: string;
}>): React.ReactNode {
    const { instrument, layout, metric } = props;
    if (props.style === 'numbers') return null;
    if (props.style === 'rings' && metric !== 'network') {
        return <CapacityRing ratio={instrument?.used ?? 0} color={props.inkColor} trackColor={props.trackColor}
            size={RING_SIZE[layout]} strokeWidth={layout === 'tiles' ? 3 : 2} />;
    }
    const linear = props.style === 'bars' || metric === 'disk';
    if (linear && metric !== 'network') {
        return <MachineSummaryMeter used={instrument?.used ?? null} color={props.inkColor} trackColor={props.trackColor}
            width={layout === 'inline' ? 16 : layout === 'tiles' ? undefined : LINE_WIDTH[layout] / (props.style === 'bars' ? 1 : 2)} />;
    }
    return <MachineSummaryLine line={instrument?.line ?? []} color={props.inkColor}
        width={LINE_WIDTH[layout]} height={LINE_HEIGHT[layout]} />;
}

/** A level meter through the shared capacity owner: fills by used, coloured by tone. */
function MachineSummaryMeter(props: Readonly<{ used: number | null; color: string; trackColor: string; width: number | undefined }>) {
    const { theme } = useUnistyles();
    const pluginTheme = usePluginUiTheme(theme);
    return (
        <View style={props.width === undefined ? stylesheet.meterFill : { width: props.width }}>
            <CapacityBar theme={pluginTheme} label="" value={props.used} capacity={1} color={props.color}
                trackColor={props.trackColor} size="inline" height={3} showCaption={false} />
        </View>
    );
}

// Summary rows announce measured values themselves; their charts have no point-selection action.
const renderSummaryBucket: NonNullable<React.ComponentProps<typeof StackedSeriesChart>['renderBucket']> = (_bucket, visual) => visual;

/** A 5-minute line through the shared chart owner, already scaled by the model (no min–max fit). */
function MachineSummaryLine(props: Readonly<{ line: readonly (number | null)[]; color: string; width: number; height: number }>) {
    const { theme } = useUnistyles();
    const pluginTheme = usePluginUiTheme(theme);
    const series = React.useMemo(() => [{ id: 'line', label: '', color: props.color,
        points: (props.line.length > 0 ? props.line : [0, 0]).map((y, index) => ({ id: String(index), x: index, y })) }], [props.color, props.line]);
    // No sample yet is not a reading of zero: the line keeps its room and draws nothing (never a flat 0 baseline).
    if (!props.line.some((y) => typeof y === 'number')) return <View style={{ width: props.width, height: props.height }} />;
    return (
        <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: props.width, height: props.height }}>
            <StackedSeriesChart theme={pluginTheme} label="" series={series} variant="line" size="inline"
                width={props.width} viewportHeight={props.height} minimumMaximum={1} strokeWidth={1.25}
                showAxis={false} showLegend={false} showGrid={false} showReadout={false} renderBucket={renderSummaryBucket} />
        </View>
    );
}

/** "19 GB free", or the pressure word in tone when memory is not calm (MPG-35). */
const MachineMemoryFact = React.memo(function MachineMemoryFact(props: Readonly<{
    instruments: Readonly<Record<MachineSummaryMetric, MachineSummaryInstrument>> | null;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const memory = props.instruments?.memory ?? null;
    if (!memory?.figure) return null;
    const calm = memory.tone === 'calm';
    const body = (
        <Text testID={props.testID} numberOfLines={1} accessible accessibilityLabel={memory.exact ?? undefined}
            style={[stylesheet.fact, { color: calm ? theme.colors.text.secondary : resolveMachineResourceToneColor(memory.tone, theme.colors) }]}>
            {calm ? t('machineSummary.memoryFreeFact', { free: memory.figure }) : memory.figure}
        </Text>
    );
    return memory.exact ? <Tooltip label={memory.exact}>{body}</Tooltip> : body;
});

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        minHeight: 16,
    },
    inlineRow: {
        gap: theme.space.s6,
    },
    // Fills the block under the name, so its own measured width is the room the instruments have.
    underRow: {
        alignSelf: 'stretch',
        minWidth: 0,
    },
    tiles: {
        flexDirection: 'row',
        alignItems: 'stretch',
    },
    stale: {
        opacity: 0.55,
    },
    instrument: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    tile: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s4,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
    },
    tileInstrument: {
        height: 24,
        justifyContent: 'center',
    },
    ringTile: {
        flex: 1,
        minWidth: 0,
    },
    ringFigure: {
        flex: 1,
        minWidth: 0,
        alignItems: 'center',
        // Neighbouring columns never touch: "46.6 GB free" ends before the next ring's "770 GB free" starts.
        paddingHorizontal: theme.space.s4,
        paddingVertical: theme.space.s4,
    },
    ringValue: {
        flexDirection: 'row',
        // A column too narrow for "27.5 GB free" puts the unit under its number rather than into the next ring's.
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'baseline',
        columnGap: theme.space.s4,
        marginTop: theme.space.s8,
        maxWidth: '100%',
    },
    ringNumber: {
        ...Typography.variant('label', 'semiBold'),
        ...Typography.default('semiBold'),
        ...Typography.tabular(),
    },
    ringUnit: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    meterFill: {
        alignSelf: 'stretch',
    },
    label: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    figure: {
        ...Typography.variant('meta'),
        ...Typography.tabular(),
    },
    figureSlot: {
        minWidth: 44,
    },
    tileFigure: {
        ...Typography.variant('label', 'semiBold'),
        ...Typography.tabular(),
    },
    fact: {
        ...Typography.variant('meta'),
    },
}));
