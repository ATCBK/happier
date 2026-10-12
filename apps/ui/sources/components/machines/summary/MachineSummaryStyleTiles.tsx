import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import { MachineSummaryStrip, machineSummaryMetricTitle } from './MachineSummaryStrip';
import { MACHINE_SUMMARY_PREVIEW } from './machineSummaryPreview';
import { MACHINE_SUMMARY_METRICS, MACHINE_SUMMARY_STYLES, type MachineSummaryMetric, type MachineSummaryStyle } from './machineSummaryStripModel';

const STYLE_TITLE_KEYS = {
    sparklines: 'machineSummary.styles.sparklines',
    bars: 'machineSummary.styles.bars',
    numbers: 'machineSummary.styles.numbers',
    rings: 'machineSummary.styles.rings',
} as const satisfies Record<MachineSummaryStyle, string>;

/**
 * The four styles as visual tiles (MPG-21): each tile is the real strip at static props for one calm
 * machine and one that needs a look, so the choice shows exactly what it changes. 2-up in the popover,
 * 4-up in Appearance.
 */
/** A style's name, for a row that only says which one is chosen. */
export function machineSummaryStyleTitle(style: MachineSummaryStyle): string {
    return t(STYLE_TITLE_KEYS[style]);
}

export const MachineSummaryStyleTiles = React.memo(function MachineSummaryStyleTiles(props: Readonly<{
    value: MachineSummaryStyle;
    metrics: readonly MachineSummaryMetric[];
    onChange(next: MachineSummaryStyle): void;
    columns: 2 | 4;
    testIdPrefix: string;
}>) {
    const language = usePreferredLanguage();
    const { metrics } = props;
    const options = React.useMemo(() => MACHINE_SUMMARY_STYLES.map(style => ({
        id: style,
        title: t(STYLE_TITLE_KEYS[style]),
        preview: <MachineSummaryStylePreview style={style} metrics={metrics} />,
    })), [language, metrics]);
    return (
        <SelectionTiles<MachineSummaryStyle>
            variant="visual"
            tileSizing="fill"
            options={options}
            value={props.value}
            onChange={(next) => { if (next) props.onChange(next); }}
            minimumColumns={props.columns}
            maximumColumns={props.columns}
            accessibilityLabel={t('machineSummary.styleTitle')}
            testIdPrefix={props.testIdPrefix}
        />
    );
});

/** The tile's preview: two machine rows, a mark and a short name each, with the style's strip beside them. */
const MachineSummaryStylePreview = React.memo(function MachineSummaryStylePreview(props: Readonly<{
    style: MachineSummaryStyle;
    metrics: readonly MachineSummaryMetric[];
}>) {
    const { theme } = useUnistyles();
    // The preview always shows instruments, so an empty Show still previews the style itself.
    const metrics = props.metrics.length > 0 ? props.metrics : MACHINE_SUMMARY_METRICS.slice(0, 3);
    return (
        <View style={stylesheet.preview}>
            {([['laptop', 'machineSummary.previewCalmName', MACHINE_SUMMARY_PREVIEW.calm], ['desktop', 'machineSummary.previewLookName', MACHINE_SUMMARY_PREVIEW.look]] as const)
                .map(([icon, nameKey, availability]) => (
                    <View key={nameKey} style={stylesheet.previewRow}>
                        <Icon name={icon} size={12} color={theme.colors.text.secondary} />
                        <Text numberOfLines={1} style={stylesheet.previewName}>{t(nameKey)}</Text>
                        <MachineSummaryStrip availability={availability} style={props.style} metrics={metrics} layout="preview" />
                    </View>
                ))}
        </View>
    );
});

/** Show: which metrics each machine shows, as compact multi-select tiles (the popover panel). None is allowed. */
export const MachineSummaryMetricTiles = React.memo(function MachineSummaryMetricTiles(props: Readonly<{
    value: readonly MachineSummaryMetric[];
    onToggle(metric: MachineSummaryMetric): void;
    testIdPrefix: string;
}>) {
    const options = React.useMemo(() => MACHINE_SUMMARY_METRICS.map(metric => ({ id: metric, title: machineSummaryMetricTitle(metric) })), []);
    const { value, onToggle } = props;
    const onChange = React.useCallback((next: MachineSummaryMetric[]) => {
        const changed = MACHINE_SUMMARY_METRICS.find(metric => next.includes(metric) !== value.includes(metric));
        if (changed) onToggle(changed);
    }, [onToggle, value]);
    return (
        <SelectionTiles<MachineSummaryMetric>
            selectionMode="multiple"
            density="compact"
            minimumColumns={4}
            maximumColumns={4}
            options={options}
            value={value}
            onChange={onChange}
            accessibilityLabel={t('machineSummary.showTitle')}
            testIdPrefix={props.testIdPrefix}
        />
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    preview: {
        gap: theme.space.s6,
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s10,
    },
    previewRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    previewName: {
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
        width: 44,
    },
}));
