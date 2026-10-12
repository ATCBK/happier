import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { MachinePresenceCounts as Counts } from '@/utils/sessions/machineUtils';

const DOT_SIZE_PX = 6;

/**
 * "● 2 online · ● 1 offline": presence at a glance beside a Machines title (Home's section, the rail
 * popover's header, the Settings Machines row). The green dot is presence itself; offline is grey,
 * never a warning — laptops sleep. A side with no machine is left out.
 */
export const MachinePresenceCounts = React.memo(function MachinePresenceCounts(props: Readonly<{
    counts: Counts;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const online = props.counts.online > 0 ? t('settingsOverview.machinesOnlineCount', { count: props.counts.online }) : null;
    const offline = props.counts.offline > 0 ? t('settingsOverview.machinesOfflineCount', { count: props.counts.offline }) : null;
    if (!online && !offline) return null;
    return (
        <View
            testID={props.testID}
            style={styles.row}
            accessible
            accessibilityLabel={describeMachinePresenceCounts(props.counts)}
        >
            {online ? (
                <View style={styles.part}>
                    <StatusDot color={theme.colors.status.connected} size={DOT_SIZE_PX} />
                    <Text style={styles.text}>{online}</Text>
                </View>
            ) : null}
            {offline ? (
                <View style={styles.part}>
                    <StatusDot color={theme.colors.status.disconnected} size={DOT_SIZE_PX} />
                    <Text style={styles.text}>{offline}</Text>
                </View>
            ) : null}
        </View>
    );
});

/** The same counts as one line of text, for a tooltip or an accessible name. */
export function describeMachinePresenceCounts(counts: Counts): string {
    return [
        counts.online > 0 ? t('settingsOverview.machinesOnlineCount', { count: counts.online }) : null,
        counts.offline > 0 ? t('settingsOverview.machinesOfflineCount', { count: counts.offline }) : null,
    ].filter(Boolean).join(' · ');
}

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        columnGap: theme.space.s10,
        rowGap: theme.space.s2,
    },
    part: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    text: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
        fontVariant: ['tabular-nums'],
    },
}));
