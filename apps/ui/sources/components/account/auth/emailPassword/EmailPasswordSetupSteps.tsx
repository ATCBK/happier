import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { HappierStepMarkerView } from '@happier-dev/plugin-ui/presentation';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

export type EmailPasswordSetupStep = 'email' | 'confirm' | 'password';
const EMAIL_PASSWORD_SETUP_STEPS: readonly EmailPasswordSetupStep[] = ['email', 'confirm', 'password'];

function setupStepLabel(step: EmailPasswordSetupStep): string {
    if (step === 'email') return t('settingsAccount.nativePassword.email');
    if (step === 'confirm') return t('settingsAccount.nativePassword.setupStepConfirm');
    return t('settingsAccount.nativePassword.password');
}

function setupStepHint(step: EmailPasswordSetupStep): string {
    if (step === 'email') return t('settingsAccount.nativePassword.setupEmailHint');
    if (step === 'confirm') return t('settingsAccount.nativePassword.setupConfirmHint');
    return t('settingsAccount.nativePassword.setupPasswordHint');
}

/**
 * The mailbox-first path to an email and password: add the email, confirm it from the inbox, then
 * choose the password. The current step leads; finished steps are ticked. Shared by every surface
 * that walks this path (Account Security, the account-service section), so the path reads the same.
 */
export function EmailPasswordSetupSteps(props: Readonly<{
    step: EmailPasswordSetupStep;
    /** Replaces the default hint for the current step when the surface can say more. */
    hint?: string;
    testID?: string;
    /** Surfaces that already inset their body drop the step block's own inset. */
    inset?: boolean;
}>) {
    const { theme } = useUnistyles();
    const presentationTheme = usePluginUiTheme(theme);
    const current = EMAIL_PASSWORD_SETUP_STEPS.indexOf(props.step);
    return (
        <View style={[styles.setup, props.inset === false ? styles.flush : null]}>
            <View
                testID={props.testID ?? 'settings-account-email-password-steps'}
                accessible
                accessibilityRole="progressbar"
                accessibilityLabel={t('settingsAccount.nativePassword.setupProgress', {
                    step: current + 1,
                    total: EMAIL_PASSWORD_SETUP_STEPS.length,
                    label: setupStepLabel(props.step),
                })}
                accessibilityValue={{ min: 1, max: EMAIL_PASSWORD_SETUP_STEPS.length, now: current + 1 }}
                style={styles.steps}
            >
                {EMAIL_PASSWORD_SETUP_STEPS.map((step, index) => {
                    const done = index < current;
                    const active = index === current;
                    const color = active ? theme.colors.text.primary : theme.colors.text.secondary;
                    return (
                        <React.Fragment key={step}>
                            {index > 0 ? <View style={styles.stepRule} /> : null}
                            <View style={styles.step}>
                                <HappierStepMarkerView marker={{ kind: 'number', value: index + 1 }}
                                    numberState={done ? 'done' : active ? 'current' : 'upcoming'} theme={presentationTheme}
                                    stateGlyph={<Icon name="check" size={12} color={theme.colors.state.success.foreground} />} />
                                <Text style={[active ? styles.stepLabelActive : styles.stepLabel, { color }]}>
                                    {setupStepLabel(step)}
                                </Text>
                            </View>
                        </React.Fragment>
                    );
                })}
            </View>
            <Text style={styles.hint}>{props.hint ?? setupStepHint(props.step)}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    setup: { paddingHorizontal: theme.space.s16, paddingTop: theme.space.s4, paddingBottom: theme.space.s10, gap: theme.space.s8, maxWidth: 560 },
    flush: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0 },
    steps: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', rowGap: theme.space.s6 },
    step: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
    stepLabel: {  ...Typography.variant('body'),  },
    stepLabelActive: {  ...Typography.variant('body', 'medium'),  },
    stepRule: { width: 16, height: 1, marginHorizontal: theme.space.s8, backgroundColor: theme.colors.border.default },
    hint: { flex: 1, fontSize: 14, lineHeight: 20, color: theme.colors.text.secondary },
}));
