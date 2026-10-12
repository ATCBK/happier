import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    MachineAdministrationTargetSelector,
    type MachineAdministrationTargetSelectorProps,
} from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * "<label> [machine chip]" above an entity page whose content is read from, or acts on, one machine
 * (an agent's setup, a provider's connections). It stays on the page through loading, offline and
 * not-found states, because the chip is the control that recovers them.
 *
 * It sits on the page's content column, like `PageHeader` actions: same max width and inset, so the
 * chip lines up with the sheets below however wide the host is (the Settings pane or a full app page).
 */
export const MachineAdministrationContextBar = React.memo(function MachineAdministrationContextBar(props: Readonly<{
    label: string;
    selection: MachineAdministrationTargetSelectorProps['selection'];
    resolveCandidateAvailability?: MachineAdministrationTargetSelectorProps['resolveCandidateAvailability'];
    testIDPrefix: string;
}>) {
    const styles = stylesheet;
    const maxWidthStyle = useLayoutMaxWidthStyle();
    return (
        <View style={[styles.bar, maxWidthStyle]}>
            <Text style={styles.label}>{props.label}</Text>
            <MachineAdministrationTargetSelector
                selection={props.selection}
                presentation="chip"
                resolveCandidateAvailability={props.resolveCandidateAvailability}
                testIDPrefix={props.testIDPrefix}
            />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: theme.space.s10,
        width: '100%',
        alignSelf: 'center',
        paddingHorizontal: PAGE_LIST_METRICS.pageTextInsetPx,
        paddingTop: 14,
    },
    label: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
}));
