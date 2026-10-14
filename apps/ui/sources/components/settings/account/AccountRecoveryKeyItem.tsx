import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAuth } from '@/auth/context/AuthContext';
import { formatRecoveryKeyForDisplay, maskRecoveryKeyForDisplay } from '@/auth/recovery/secretKeyBackup';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { FocusReturnTarget } from '@/keyboard/focusReturn';
import { Modal } from '@/modal';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import { useRecoveryKeyDisclosure, type RecoveryKeySource } from './useRecoveryKeyDisclosure';

const MASKED_RECOVERY_KEY = maskRecoveryKeyForDisplay();

/** Wipes a recovery secret handed over as bytes once its display form has been taken. */
function takeDisplayForm(secret: string | Uint8Array): string {
    const formatted = formatRecoveryKeyForDisplay(secret);
    if (secret instanceof Uint8Array) secret.fill(0);
    return formatted;
}

/**
 * The recovery key, masked in place, with reveal and copy. Both go through the same guard as the
 * backup disclosure (`useRecoveryKeyDisclosure`): the local secret when this device holds it,
 * otherwise an unlock with the sign-in password. The revealed key lives only while it is shown; hiding
 * it, leaving the page or changing Account forgets it.
 */
export const AccountRecoveryKeyItem = React.memo(function AccountRecoveryKeyItem(props: Readonly<{
    recoveryEmail: string | null;
    showDivider?: boolean;
    /** Whose key this row shows; the signed-in Home Account by default. */
    source?: RecoveryKeySource;
    /** Test-ID stem for the row's parts, so two rows on one page stay distinct. */
    testIDPrefix?: string;
    /** Any change (another Account or service) forgets a revealed key, as an Account change does. */
    scopeKey?: string;
}>) {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const triggerRef = React.useRef<FocusReturnTarget>(null);
    const { withRecoveryKey } = useRecoveryKeyDisclosure(props.recoveryEmail, triggerRef, props.source);
    const [revealed, setRevealed] = React.useState<string | null>(null);
    const copyFeedback = useHappierCopyFeedback();
    const prefix = props.testIDPrefix ?? 'settings-account-recovery-key';

    // A different Account (or none) never inherits a key revealed for the previous one.
    React.useEffect(() => { setRevealed(null); }, [auth.credentials, props.scopeKey]);

    const toggleReveal = React.useCallback(() => {
        if (revealed) {
            setRevealed(null);
            return;
        }
        withRecoveryKey((secret) => { setRevealed(takeDisplayForm(secret)); });
    }, [revealed, withRecoveryKey]);

    const copy = React.useCallback(() => {
        withRecoveryKey(async (secret) => {
            if (!await setClipboardStringSafe(takeDisplayForm(secret))) {
                Modal.alert(t('common.error'), t('settingsAccount.secretKeyCopyFailed'));
                return;
            }
            copyFeedback.markCopied();
        });
    }, [copyFeedback, withRecoveryKey]);

    return (
        <Item
            testID={props.testIDPrefix ? prefix : "settings-account-signin-recovery-key"}
            icon={<Icon name="key" size={18} color={theme.colors.text.secondary} />}
            title={t('settingsAccount.secretKey')}
            subtitle={(
                <Text
                    testID={`${prefix}-value`}
                    style={styles.key}
                    selectable={revealed !== null}
                    // The masked form is only a shape; the revealed key wraps so it can be read whole.
                    numberOfLines={revealed ? undefined : 1}
                    accessibilityLabel={revealed ? undefined : t('settingsAccount.backupDescription')}
                >
                    {revealed ?? MASKED_RECOVERY_KEY}
                </Text>
            )}
            accessibilityHint={t('settingsAccount.backupDescription')}
            mode="info"
            showChevron={false}
            showDivider={props.showDivider}
            rightElementOutsidePressable
            rightElement={(
                <View style={styles.actions}>
                    <IconButton
                        testID={`${prefix}-reveal`}
                        accessibilityLabel={revealed ? t('settingsAccount.hideRecoveryKey') : t('settingsAccount.showRecoveryKey')}
                        tooltip={revealed ? t('settingsAccount.hideRecoveryKey') : t('settingsAccount.showRecoveryKey')}
                        iconName={revealed ? 'eye-slash' : 'eye'}
                        variant="plain"
                        onPress={toggleReveal}
                    />
                    {copyFeedback.isCopied() ? (
                        <CopiedPill visible testID={`${prefix}-copied`} />
                    ) : (
                        <RoundButton
                            testID={`${prefix}-copy`}
                            controlRef={(node) => { triggerRef.current = node; }}
                            size="small"
                            display="secondary"
                            title={t('common.copy')}
                            accessibilityLabel={`${t('common.copy')}: ${t('settingsAccount.secretKey')}`}
                            onPress={copy}
                        />
                    )}
                </View>
            )}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    key: {
        ...Typography.mono(),
        fontSize: 12.5,
        lineHeight: 18,
        letterSpacing: 0.5,
        color: theme.colors.text.secondary,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
}));
