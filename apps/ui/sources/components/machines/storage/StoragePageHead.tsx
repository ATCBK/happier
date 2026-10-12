import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/iconRegistry.generated';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The one sentence a Storage view opens with (lab `rs` `sayLine`): what is true now in ink ("412 GB free."),
 * then what it means in the secondary ink. Every Storage view and page says it through this owner.
 */
export function StorageSayLine(props: Readonly<{ lead?: string | null; text: string; testID?: string }>) {
    return (
        <Text testID={props.testID} style={styles.sentence}>
            {props.lead ? <Text style={styles.sentenceLead}>{`${props.lead} `}</Text> : null}
            {props.text}
        </Text>
    );
}

/** A Storage view's sentence standing on its own in the page column (the Happier and Whole disk views). */
export function StorageSaySection(props: Readonly<{ lead?: string | null; text: string; testID?: string }>) {
    return (
        <ItemGroup surface="none" header="none">
            <StorageSayLine {...props} />
        </ItemGroup>
    );
}

/**
 * The head of a page behind the Storage tab (lab `rs` `subHead`): the way back, the page's name and its
 * sentence, in the page column. Worktrees, Suggestions, a kind's page and Protected folders share it.
 */
export function StoragePageHead(props: Readonly<{ title: string; onBack: () => void; children?: React.ReactNode }>) {
    const { theme } = useUnistyles();
    return (
        <ItemGroup surface="none" header="none">
            <HappierPressable testID="machine-storage-page-back" accessibilityRole="link" accessibilityLabel={t('machineStorage.page.back')}
                onPress={props.onBack} style={(state) => [styles.back, state.pressed ? styles.backPressed : null]}>
                {(state) => (
                    <>
                        <Icon name="caret-left" size={14} color={state.hovered ? theme.colors.text.primary : theme.colors.text.secondary} />
                        <Text style={[styles.backText, state.hovered ? { color: theme.colors.text.primary } : null]}>{t('machineStorage.page.back')}</Text>
                    </>
                )}
            </HappierPressable>
            <Text accessibilityRole="header" style={styles.title}>{props.title}</Text>
            {props.children}
        </ItemGroup>
    );
}

/**
 * A quiet line of reassurance under a Storage list, on the rows' edge (lab `rs` `hint`): what Happier
 * reads, what a scan skips, when a suggestion appears.
 */
export function StorageHint(props: Readonly<{ icon: IconName; text: string }>) {
    const { theme } = useUnistyles();
    return (
        <ItemGroup surface="none" header="none">
            <View style={styles.hint}>
                <Icon name={props.icon} size={14} color={theme.colors.text.tertiary} />
                <Text style={styles.hintText}>{props.text}</Text>
            </View>
        </ItemGroup>
    );
}

const styles = StyleSheet.create((theme) => ({
    hint: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    hintText: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
        flex: 1,
    },
    back: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: theme.space.s2,
        minHeight: 28,
        marginLeft: -2,
    },
    backPressed: {
        opacity: 0.6,
    },
    backText: {
        ...Typography.default('medium'),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
    },
    title: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('pageTitle'),
        color: theme.colors.text.primary,
        marginTop: theme.space.s4,
    },
    sentence: {
        ...Typography.default(),
        ...happierPageTextMetrics('pageDescription'),
        color: theme.colors.text.secondary,
        marginTop: theme.space.s6,
    },
    sentenceLead: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
}));
