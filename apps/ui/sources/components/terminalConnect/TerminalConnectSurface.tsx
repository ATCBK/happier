import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { FlowSurfaceActions, FlowSurfaceChrome } from '@/components/ui/flowSurface';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';

type TerminalConnectMessageState = Readonly<{
    kind: 'message';
    title: string;
    description?: string;
    tone?: 'default' | 'critical';
    loading?: boolean;
}>;

type TerminalConnectApprovalState = Readonly<{
    kind: 'approval';
    publicKey: string;
    isLoading: boolean;
    homeUrl: string;
    storageMode: 'plain' | 'e2ee' | null;
    needsSignIn?: boolean;
    errorDescription?: string;
    onRetry?: () => void;
    onApprove: () => void | Promise<void>;
    onReject: () => void | Promise<void>;
}>;

export type TerminalConnectSurfaceState =
    | TerminalConnectMessageState
    | TerminalConnectApprovalState;

export type TerminalConnectSurfaceProps = Readonly<{
    testID?: string;
    state: TerminalConnectSurfaceState;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    icon: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    section: {
        gap: theme.space.s8,
    },
    sectionTitle: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    sectionBody: {
        gap: theme.space.s6,
    },
    sectionLine: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    securityBlock: {
        paddingTop: theme.space.s6,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
        gap: theme.space.s8,
    },
    securityRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s10,
    },
    securityCopy: {
        flex: 1,
        gap: theme.space.s4,
    },
    securityTitle: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    securitySubtitle: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    message: {
        alignItems: 'center',
        gap: theme.space.s12,
        paddingVertical: theme.space.s10,
    },
}));

function truncatePublicKey(publicKey: string): string {
    const value = String(publicKey ?? '').trim();
    if (value.length <= 12) return value;
    return `${value.slice(0, 12)}...`;
}

export function TerminalConnectSurface(props: TerminalConnectSurfaceProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    if (props.state.kind === 'message') {
        return (
            <FlowSurfaceChrome
                testID={props.testID}
                showScrim={false}
                title={props.state.title}
                subtitle={props.state.description}
            >
                <View style={styles.message}>
                    {props.state.loading ? (
                        <ActivitySpinner color={theme.colors.button.primary.background} />
                    ) : (
                        <Icon
                            name={props.state.tone === 'critical' ? 'warning' : 'terminal'}
                            size={34}
                            color={props.state.tone === 'critical' ? theme.colors.state.danger.foreground : theme.colors.radio.active}
                        />
                    )}
                </View>
            </FlowSurfaceChrome>
        );
    }

    return (
        <FlowSurfaceChrome
            testID={props.testID}
            showScrim={false}
            titleLeading={(
                <View style={styles.icon}>
                    <Icon name="terminal" size={32} color={theme.colors.radio.active} />
                </View>
            )}
            title={t('terminal.connectTerminal')}
            subtitle={t('terminal.terminalRequestDescription')}
            footer={(
                <FlowSurfaceActions
                    primary={{
                        testID: 'terminal-connect-approve',
                        label: props.state.isLoading ? t('terminal.connecting')
                            : props.state.onRetry ? t('common.retry')
                                : props.state.needsSignIn ? t('common.continue') : t('terminal.acceptConnection'),
                        onPress: props.state.onRetry ?? props.state.onApprove,
                        disabled: props.state.isLoading || (!props.state.storageMode && !props.state.needsSignIn && !props.state.onRetry),
                        loading: props.state.isLoading,
                    }}
                    secondary={{
                        testID: 'terminal-connect-reject',
                        label: t('terminal.reject'),
                        onPress: props.state.onReject,
                        disabled: props.state.isLoading,
                    }}
                />
            )}
        >
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('terminal.connectionDetails')}</Text>
                <View style={styles.sectionBody}>
                    <Text style={styles.sectionLine}>
                        {t('server.customServerUrlLabel')}: {props.state.homeUrl}
                    </Text>
                    <Text style={styles.sectionLine}>
                        {t('terminal.publicKey')}: {truncatePublicKey(props.state.publicKey)}
                    </Text>
                    <Text style={styles.sectionLine}>
                        {t('terminal.encryption')}: {props.state.storageMode === 'e2ee'
                            ? t('terminal.endToEndEncrypted')
                            : props.state.storageMode === 'plain' ? t('terminal.plaintextStorage')
                                : props.state.errorDescription ?? (props.state.needsSignIn ? t('modals.pleaseSignInFirst') : t('common.loading'))}
                    </Text>
                </View>
            </View>

            <View style={styles.securityBlock}>
                <Text style={styles.sectionTitle}>{t('terminal.security')}</Text>
                <View style={styles.securityRow}>
                    <Icon name="shield-check" size={20} color={theme.colors.state.success.foreground} />
                    <View style={styles.securityCopy}>
                        <Text style={styles.securityTitle}>{t('terminal.clientSideProcessing')}</Text>
                        <Text style={styles.securitySubtitle}>{t('terminal.linkProcessedOnDevice')}</Text>
                        {props.state.storageMode ? (
                            <Text style={styles.securitySubtitle}>{props.state.storageMode === 'plain'
                                ? t('terminal.plaintextStorageDescription') : t('terminal.securityFooterDevice')}</Text>
                        ) : null}
                    </View>
                </View>
            </View>
        </FlowSurfaceChrome>
    );
}
