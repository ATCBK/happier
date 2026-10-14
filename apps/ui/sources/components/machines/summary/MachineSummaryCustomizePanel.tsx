import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { MachineSummaryMetricTiles, MachineSummaryStyleTiles } from './MachineSummaryStyleTiles';
import { useMachineSummarySetting } from './useMachineSummarySetting';

/**
 * "Customize summary" in the Machines popover (lab `CS` 2–6): the style tiles 2-up, then Show, then where
 * the choice applies. A choice applies at once — the rows beneath are the live preview — and Done closes
 * the panel; nothing else in the popover moves.
 */
export const MachineSummaryCustomizePanel = React.memo(function MachineSummaryCustomizePanel(props: Readonly<{ onDone(): void }>) {
    const setting = useMachineSummarySetting();
    return (
        <View style={stylesheet.panel} testID="machines.summary.customize">
            <View style={stylesheet.header}>
                <Text style={stylesheet.title}>{t('machineSummary.settingTitle')}</Text>
                <RoundButton testID="machines.summary.customize.done" size="small" display="secondary" title={t('machineSummary.done')} onPress={props.onDone} />
            </View>
            <MachineSummaryStyleTiles value={setting.style} metrics={setting.metrics} onChange={setting.setStyle} columns={2}
                testIdPrefix="machines.summary.customize.style" />
            <Text style={stylesheet.label}>{t('machineSummary.showTitle')}</Text>
            <MachineSummaryMetricTiles value={setting.metrics} onToggle={setting.toggleMetric} testIdPrefix="machines.summary.customize.show" />
            <Text style={stylesheet.caption}>{t('machineSummary.usedHere')}</Text>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    panel: {
        gap: theme.space.s10,
        marginHorizontal: theme.space.s8,
        marginBottom: theme.space.s8,
        padding: theme.space.s12,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.sectionTint,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    title: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    label: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    caption: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
}));
