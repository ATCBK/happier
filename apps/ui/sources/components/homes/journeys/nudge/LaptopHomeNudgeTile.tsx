import * as React from 'react';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { HomeMark } from '@/components/homes/HomeMark';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

import { SetupBlockPaper } from '@/components/ui/setupBlocks/SetupBlockPaper';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { View } from 'react-native';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { StyleSheet } from 'react-native-unistyles';
import type { LaptopHomeNudgeFacts } from './useLaptopHomeNudgeFacts';

/**
 * The reachability nudge (J6): the first Get set up item for the focused Home, only
 * after real missed reaches, naming them in numbers. Its two ways out are stacked at the end so the
 * explanation keeps the width: Move Home… (the existing relocation on the Home's Runtime page) above
 * Use <service> (J3), which appears only when the service is also a Home.
 */
export function LaptopHomeNudgeTile(props: Readonly<{
    facts: LaptopHomeNudgeFacts;
    /** Present only when the sign-in service is also a Home. */
    serviceName: string | null;
    onMoveHome: () => void;
    onUseService: () => void;
    onDismiss?: () => void;
}>) {
    const title = t('homesJourneys.nudgeTitle', { count: props.facts.missedReachesThisWeek });
    // A narrow window has no room for the line: the tile stacks, its ways out beneath the explanation.
    const narrow = useViewportClass() === 'compact';
    return (
        <SetupBlockPaper
            testID="laptop-home-nudge"
            layout={narrow ? 'card' : 'wide'}
            accessibilityLabel={title}
            dismiss={props.onDismiss ? {
                label: t('homesJourneys.nudgeDismiss'),
                tooltip: t('homesJourneys.nudgeDismiss'),
                onPress: props.onDismiss,
            } : undefined}
        >
            <HomeMark serverUrl={getServerProfileById(props.facts.homeServerId)?.serverUrl} size="page" />
            <View style={styles.copy}>
                <Text style={styles.title}>{title}</Text>
                <Text style={styles.description}>{t('homesJourneys.nudgeBody')}</Text>
            </View>
            {/* Its two ways out stacked at the end, so the explanation keeps the width. */}
            <View style={narrow ? styles.actionsNarrow : styles.actions}>
                <RoundButton testID="laptop-home-nudge.move" size="small" display="secondary" title={t('homesJourneys.moveHome')} onPress={props.onMoveHome} />
                {props.serviceName ? (
                    <RoundButton testID="laptop-home-nudge.use-service" size="small" display="inverted"
                        title={t('homesJourneys.useService', { service: props.serviceName })} onPress={props.onUseService} />
                ) : null}
            </View>
        </SetupBlockPaper>
    );
}

const styles = StyleSheet.create((theme) => ({
    copy: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.primary,
    },
    description: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        marginTop: theme.space.s2,
        color: theme.colors.text.secondary,
    },
    actionsNarrow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s6,
    },
    actions: {
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: theme.space.s4,
        width: 164,
    },
}));
