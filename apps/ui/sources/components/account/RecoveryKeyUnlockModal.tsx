import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PasswordField } from '@/components/account/auth/emailPassword/PasswordField';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text, TextInput } from '@/components/ui/text/Text';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { recoverPasswordEnvelopeSecret } from '@/auth/password/recoverPasswordEnvelopeSecret';
import type { ServerFetch } from '@/sync/http/client';
import { t } from '@/text';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

type Props = CustomModalInjectedProps & Readonly<{
    /** The sign-in email when the caller knows it; null asks for it (an account-service Account). */
    email: string | null;
    request: ServerFetch;
    onUnlocked(secret: Uint8Array): void | Promise<void>;
}>;

export function RecoveryKeyUnlockModal(props: Props) {
    const { theme } = useUnistyles();
    const [password, setPassword] = React.useState('');
    const [typedEmail, setTypedEmail] = React.useState('');
    const email = props.email ?? typedEmail.trim();
    const [pending, setPending] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    const abortRef = React.useRef<AbortController | null>(null);
    const passwordRef = React.useRef<{ focus(): void } | null>(null);

    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: t('settingsAccount.secretKey'),
        testID: 'recovery-key-unlock-modal',
        bodyScroll: 'auto' as const,
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.default, maxHeightRatio: 0.85, size: 'dialog' as const },
    }), []));

    React.useEffect(() => () => {
        abortRef.current?.abort();
    }, []);

    const submit = React.useCallback(async () => {
        if (!email || !password || pending) {
            if (email) passwordRef.current?.focus();
            return;
        }
        const controller = new AbortController();
        abortRef.current = controller;
        setPending(true);
        setFailed(false);
        let secret: Uint8Array | undefined;
        try {
            secret = await recoverPasswordEnvelopeSecret({
                request: props.request,
                email,
                password,
                signal: controller.signal,
            });
            setPassword('');
            props.onClose();
            await props.onUnlocked(secret);
        } catch {
            if (!controller.signal.aborted) {
                setFailed(true);
                passwordRef.current?.focus();
            }
        } finally {
            secret?.fill(0);
            if (!controller.signal.aborted) {
                setPassword('');
                setPending(false);
            }
            if (abortRef.current === controller) abortRef.current = null;
        }
    }, [email, password, pending, props]);

    return <View style={styles.body}>
        <Text style={styles.description}>{t('settingsAccount.nativePassword.currentPasswordRequired')}</Text>
        {props.email === null ? (
            <FieldItem label={t('settingsAccount.nativePassword.email')}>
                <TextInput
                    testID="recovery-key-unlock-email"
                    accessibilityLabel={t('settingsAccount.nativePassword.email')}
                    style={[styles.input, { color: theme.colors.text.primary, borderColor: theme.colors.border.default }]}
                    value={typedEmail}
                    onChangeText={setTypedEmail}
                    placeholder={t('settingsAccount.nativePassword.emailPlaceholder')}
                    placeholderTextColor={theme.colors.text.secondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    inputMode="email"
                    autoComplete="username"
                    textContentType="username"
                    editable={!pending}
                    returnKeyType="next"
                    onSubmitEditing={() => passwordRef.current?.focus()}
                />
            </FieldItem>
        ) : null}
        <PasswordField
            testID="recovery-key-unlock-password"
            inputRef={passwordRef}
            label={t('settingsAccount.nativePassword.currentPassword')}
            value={password}
            onChangeText={setPassword}
            editable={!pending}
            autoComplete="current-password"
            returnKeyType="go"
            onSubmitEditing={submit}
            error={failed ? t('settingsAccount.nativePassword.signInFailed') : null}
        />
        {pending ? <Text accessibilityLiveRegion="polite" style={[styles.description, { color: theme.colors.text.secondary }]}>
            {t('settingsAccount.nativePassword.working')}
        </Text> : null}
        <RoundButton testID="recovery-key-unlock-submit" title={t('settingsAccount.nativePassword.continue')} action={submit} size="normal" />
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    body: { padding: theme.space.s16, gap: 14 },
    description: { color: theme.colors.text.secondary, fontSize: 14, lineHeight: 20 },
    input: {
        borderWidth: 1,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s10,
        minHeight: 44,
    },
}));
