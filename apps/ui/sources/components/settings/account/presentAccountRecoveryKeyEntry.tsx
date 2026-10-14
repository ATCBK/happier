import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SecretKeyEntryForm } from '@/components/account/restore/SecretKeyEntryForm';
import { Modal, type CustomModalInjectedProps, type IModal } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

type AccountRecoveryKeyEntryHost = Pick<IModal, 'show' | 'hide'>;

type AccountRecoveryKeyEntryModalProps = CustomModalInjectedProps & Readonly<{
    onEntered: (secret: Uint8Array) => void;
}>;

function AccountRecoveryKeyEntryModal(props: AccountRecoveryKeyEntryModalProps) {
    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: t('settingsAccount.secretKey'),
        testID: 'account-recovery-key-entry-modal',
        bodyScroll: 'auto' as const,
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.default, maxHeightRatio: 0.9, size: 'dialog' as const },
    }), []));

    return (
        <View style={styles.body}>
            <SecretKeyEntryForm
                description={t('settingsAccount.nativePassword.recoveryKeyRequired')}
                submitTitle={t('settingsAccount.nativePassword.continue')}
                onSubmit={async ({ secret }) => {
                    // The entry owner zeroes its buffer once this resolves, so the
                    // caller receives its own copy and owns the wipe from here on.
                    props.onEntered(secret);
                    return { kind: 'completed' };
                }}
            />
        </View>
    );
}

/**
 * Ask for the existing recovery key so an E2EE Account can mutate its password
 * on a device that holds no recovery secret.
 *
 * The key never leaves this process: the caller uses it only through the
 * existing purpose-bound Key Challenge proof and envelope writers.
 */
export function presentAccountRecoveryKeyEntry(
    host: AccountRecoveryKeyEntryHost = Modal,
): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
        let settled = false;
        let modalId: string | null = null;
        const settle = (secret: Uint8Array | null) => {
            if (settled) return;
            settled = true;
            resolve(secret);
        };
        modalId = host.show({
            component: AccountRecoveryKeyEntryModal,
            props: {
                onEntered: (secret: Uint8Array) => {
                    settle(secret.slice());
                    if (modalId !== null) host.hide(modalId);
                },
            },
            closeOnBackdrop: true,
            onHostUnmount: () => settle(null),
        });
    });
}

const styles = StyleSheet.create(() => ({
    body: { padding: 16, gap: 12 },
}));
