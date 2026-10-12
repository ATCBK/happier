import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { presentThisComputerConnection } from '@/components/settings/machines/localControl/thisComputerConnectionPresentation';
import { t } from '@/text';
import { PersonalHomeDiagnosticDetails } from '../setup/PersonalHomeDiagnosticDetails';
import type { NormalizedSetupDetail } from './personalHomeBootstrapTypes';

const styles = StyleSheet.create((theme) => ({
    root: {
        padding: theme.space.s16,
        paddingBottom: theme.space.s20,
        gap: theme.space.s10,
        backgroundColor: theme.colors.background.canvas,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    message: {  color: theme.colors.text.secondary, ...Typography.variant('body'),  },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s10 },
    details: { width: '100%' },
}));

/**
 * Post-shell recovery for secondary Personal Home work such as profile completion or daemon
 * preparation. The usable Home stays released while the same controller operation is retried.
 */
export const PersonalHomeRecoveryStrip = React.memo(function PersonalHomeRecoveryStrip(props: Readonly<{
    kind: 'profile' | 'computer';
    pending?: boolean;
    activeTask?: SystemTaskRunState | null;
    detail?: NormalizedSetupDetail;
    onOpenDetails?: () => void;
    onRetry?: () => void;
}>) {
    const [detailsOpen, setDetailsOpen] = React.useState(false);
    // A failure that is a fact about this computer's daemon (another account, another Home…) reads
    // as the same localized sentence and action every surface uses; Details stays diagnostic only.
    const computerPresentation = !props.pending && props.kind === 'computer' && props.detail?.thisComputer
        ? presentThisComputerConnection(props.detail.thisComputer)
        : null;
    const message = props.pending
        ? props.kind === 'computer'
            ? t('personalHome.bootstrap.preparingComputerStatus')
            : t('personalHome.bootstrap.ensuringHomeStatus')
        : computerPresentation
            ? computerPresentation.description
            : props.kind === 'computer'
                ? t('personalHome.bootstrap.computerRecoveryBody')
                : t('personalHome.bootstrap.profileRecoveryBody');
    const retryLabel = computerPresentation?.actionLabel ?? t('common.retry');
    const hasDetails = props.onOpenDetails != null || props.activeTask != null || props.detail != null;
    const openDetails = React.useCallback(() => {
        if (props.onOpenDetails) {
            props.onOpenDetails();
            return;
        }
        setDetailsOpen((value) => !value);
    }, [props.onOpenDetails]);
    return (
        <View
            testID={props.pending ? 'personal-home-bootstrap-pending-strip' : 'personal-home-recovery-strip'}
            accessibilityLiveRegion="polite"
            style={styles.root}
        >
            <Text style={styles.message}>{message}</Text>
            <View style={styles.actions}>
                {!props.pending && props.onRetry ? (
                    <RoundButton
                        size="normal"
                        testID="personal-home-recovery-retry"
                        accessibilityLabel={retryLabel}
                        onPress={props.onRetry}
                        title={retryLabel}
                    />
                ) : null}
                {!props.pending && hasDetails ? (
                    <RoundButton
                        size="normal"
                        display="inverted"
                        testID="personal-home-recovery-details"
                        accessibilityLabel={t('common.details')}
                        expanded={props.onOpenDetails ? undefined : detailsOpen}
                        onPress={openDetails}
                        title={t('common.details')}
                    />
                ) : null}
            </View>
            {detailsOpen && (props.activeTask || props.detail) ? (
                <View testID="personal-home-recovery-details-panel" style={styles.details}>
                    <PersonalHomeDiagnosticDetails detail={props.detail} activeTask={props.activeTask} />
                </View>
            ) : null}
        </View>
    );
});
