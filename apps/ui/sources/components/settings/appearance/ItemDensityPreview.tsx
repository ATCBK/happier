import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { Item } from '@/components/ui/lists/Item';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem, type SegmentedChoiceItemProps } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { t, type TranslationKeyNoParams } from '@/text';

type SampleRow = Readonly<{ id: string; flavor: string; titleKey: TranslationKeyNoParams; subtitleKey: TranslationKeyNoParams; status: 'connected' | 'actionRequired' | 'default' }>;

const SAMPLE_ROWS: readonly SampleRow[] = [
    { id: 'happier-sample-a', flavor: 'claude', titleKey: 'settingsAppearance.densityPreview.sessionTitle1', subtitleKey: 'settingsAppearance.densityPreview.sessionSubtitle1', status: 'connected' },
    { id: 'happier-sample-b', flavor: 'codex', titleKey: 'settingsAppearance.densityPreview.sessionTitle2', subtitleKey: 'settingsAppearance.densityPreview.sessionSubtitle2', status: 'actionRequired' },
    { id: 'happier-sample-c', flavor: 'claude', titleKey: 'settingsAppearance.densityPreview.sessionTitle3', subtitleKey: 'settingsAppearance.densityPreview.sessionSubtitle3', status: 'default' },
];

/**
 * Sample session rows as the app draws them: real `Item` rows at the chosen density in the ordinary
 * list presentation that the setting governs (a configuration page's own rows keep page metrics),
 * with the real `Avatar`, so the avatar style and agent icons show too. Text size applies as well,
 * since `Text` scales. Static sample content — no session data or subscriptions.
 */
export const SampleSessionRows = React.memo(function SampleSessionRows(props: Readonly<{
    density: LocalSettings['uiItemDensity'];
    /** Rows after a caption start with a hairline; a list that opens a sheet does not. */
    leadingDivider?: boolean;
}>) {
    return (
        <ListPresentationProvider value="grouped">
            {SAMPLE_ROWS.map((row, index) => (
                <View key={row.id} style={index > 0 || props.leadingDivider ? styles.row : undefined}>
                    <Item
                        density={props.density}
                        title={t(row.titleKey)}
                        subtitle={t(row.subtitleKey)}
                        icon={<Avatar id={row.id} size={28} flavor={row.flavor} />}
                        rightElement={<StatusDot status={row.status} />}
                        showChevron={false}
                        showDivider={index < SAMPLE_ROWS.length - 1}
                    />
                </View>
            ))}
        </ListPresentationProvider>
    );
});

/** What the density choice changes, beneath the choice: the sample session rows in a small frame. */
export const ItemDensityPreview = React.memo(function ItemDensityPreview(props: Readonly<{
    density: LocalSettings['uiItemDensity'];
}>) {
    return (
        <View style={styles.frame} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Text style={styles.caption}>{t('settingsAppearance.densityPreview.title')}</Text>
            <SampleSessionRows density={props.density} leadingDivider />
        </View>
    );
});

type ItemDensity = LocalSettings['uiItemDensity'];

/**
 * The density row: the segmented choice with its preview directly beneath it, as one row of the
 * section. `ItemGroup` (through `SettingAnchor`) injects `showDivider`, which belongs under the preview.
 * Where the page already shows the live preview beside its sections, the row is the choice alone.
 */
export function ItemDensityChoiceRow(props: Omit<SegmentedChoiceItemProps<ItemDensity>, 'showDivider'> & Readonly<{
    showDivider?: boolean;
    previewShownElsewhere?: boolean;
}>) {
    const { showDivider, previewShownElsewhere, ...choiceProps } = props;
    if (previewShownElsewhere) return <SegmentedChoiceItem<ItemDensity> {...choiceProps} showDivider={showDivider} />;
    return (
        <View>
            <SegmentedChoiceItem<ItemDensity> {...choiceProps} showDivider={false} />
            <SectionContentRow continuesRow showDivider={showDivider}>
                <ItemDensityPreview density={props.value} />
            </SectionContentRow>
        </View>
    );
}

function StatusDot(props: Readonly<{ status: SampleRow['status'] }>) {
    return <View style={[styles.dot, styles[`dot_${props.status}`]]} />;
}

const styles = StyleSheet.create((theme) => ({
    frame: {
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.background.canvas,
        overflow: 'hidden',
    },
    caption: {
        ...Typography.variant('micro'),
        color: theme.colors.text.tertiary,
        paddingHorizontal: 14,
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s4,
    },
    row: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
    },
    dot: {
        width: 7,
        height: 7,
        borderRadius: 3.5,
    },
    dot_connected: {
        backgroundColor: theme.colors.status.connected,
    },
    dot_actionRequired: {
        backgroundColor: theme.colors.status.actionRequired,
    },
    dot_default: {
        backgroundColor: theme.colors.status.default,
    },
}));
