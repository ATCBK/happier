import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    AccountDirectoryAuthTransport,
    AccountServiceEmailPasswordExecution,
    VerifiedAccountServiceAuthority,
} from '@/auth/accountDirectory/accountDirectoryAuthClient';
import {
    authenticateSelectedAccountServiceWithPassword,
    type AccountServiceKeyAuthOutcome,
} from '@/auth/accountDirectory/accountDirectoryKeyAuth';
import { EmailPasswordSetupSteps } from '@/components/account/auth/emailPassword/EmailPasswordSetupSteps';
import { PasswordField } from '@/components/account/auth/emailPassword/PasswordField';
import {
    createEmailPasswordDraft,
    describeEmailPasswordFailure,
    resolveEmailPasswordProblemMessage,
    validateEmailPasswordDraft,
    type EmailPasswordDraft,
    type EmailPasswordProblem,
} from '@/components/account/auth/emailPassword/emailPasswordFormModel';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { Icon } from '@/components/ui/icons/Icon';
import { Text, TextInput } from '@/components/ui/text/Text';
import { requestNativeEmailVerification, requestNativePasswordReset } from '@/sync/api/auth/nativeAuthEmail';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { t } from '@/text';

export type AccountServicePasswordFormView = 'sign_in' | 'create';

type FormView =
    | Readonly<{ kind: 'sign_in' }>
    | Readonly<{ kind: 'forgot' }>
    | Readonly<{ kind: 'reset_sent'; email: string }>
    | Readonly<{ kind: 'create' }>
    | Readonly<{ kind: 'create_sent'; email: string }>;

export type AccountServicePasswordFormProps = Readonly<{
    service: VerifiedAccountServiceAuthority;
    /** The configured service's name, from its display-name owner. */
    serviceName: string;
    transport?: AccountDirectoryAuthTransport;
    /** The service's email sign-in, when it advertises one. */
    login: AccountServiceEmailPasswordExecution | null;
    /** `create` is opened only when the service advertises email account creation. */
    initialView: AccountServicePasswordFormView;
    /** Receives the signed-in session; the host runs its own continuation. */
    onSignedIn: (outcome: Extract<AccountServiceKeyAuthOutcome, { kind: 'authenticated' }>) => void | Promise<void>;
    onCancel: () => void;
}>;

/**
 * Email and password for an account service, inline where its sign-in is offered. Sign-in runs the
 * one native password login against the service (its Account mode decides Plain or E2EE); creating
 * an account proves the mailbox first (① Email → ② Confirm link → ③ Password on the landing), and
 * a forgotten password is offered only when the service says it can mail the link.
 */
export const AccountServicePasswordForm = React.memo(function AccountServicePasswordForm(props: AccountServicePasswordFormProps) {
    const { theme } = useUnistyles();
    const [view, setView] = React.useState<FormView>(() => ({ kind: props.initialView }));
    const [draft, setDraft] = React.useState<EmailPasswordDraft>(() => createEmailPasswordDraft(''));
    const [problem, setProblem] = React.useState<EmailPasswordProblem | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [resent, setResent] = React.useState(false);
    const mountedRef = React.useRef(true);
    const abortRef = React.useRef<AbortController | null>(null);
    const emailRef = React.useRef<{ focus: () => void } | null>(null);
    const passwordRef = React.useRef<{ focus: () => void } | null>(null);
    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            abortRef.current?.abort();
        };
    }, []);
    React.useEffect(() => { setView({ kind: props.initialView }); setProblem(null); }, [props.initialView]);

    const canReset = props.login?.passwordReset === 'email';
    const problemMessage = problem ? resolveEmailPasswordProblemMessage(problem) : null;
    const focusProblem = React.useCallback((next: EmailPasswordProblem) => {
        setProblem(next);
        if (next.field === 'email') emailRef.current?.focus();
        else if (next.field === 'password') passwordRef.current?.focus();
    }, []);

    const publicRequest = React.useCallback(() => createServerFetchAtEndpoint({
        endpointUrl: props.service.endpointUrl,
        serverId: props.service.serverIdentityId,
        credentials: null,
        ...(props.transport?.runtimeOrigin ? { runtimeOrigin: props.transport.runtimeOrigin } : {}),
        ...(props.transport?.homeCarrier ? { homeCarrier: props.transport.homeCarrier } : {}),
    }), [props.service.endpointUrl, props.service.serverIdentityId, props.transport]);

    const run = React.useCallback(async (operation: (signal: AbortSignal) => Promise<void>) => {
        if (busy) return;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setProblem(null);
        setBusy(true);
        try {
            await operation(controller.signal);
        } catch (cause) {
            if (!mountedRef.current || controller.signal.aborted) return;
            focusProblem(describeEmailPasswordFailure(cause, { homeLabel: props.serviceName }));
        } finally {
            if (mountedRef.current && abortRef.current === controller) setBusy(false);
        }
    }, [busy, focusProblem, props.serviceName]);

    const submitSignIn = React.useCallback(() => run(async (signal) => {
        const validated = validateEmailPasswordDraft({ purpose: 'login', draft });
        if (!validated.ok) {
            focusProblem(validated.problem);
            return;
        }
        const outcome = await authenticateSelectedAccountServiceWithPassword({
            service: props.service,
            email: validated.email,
            password: validated.password,
            signal,
            transport: props.transport,
        });
        if (outcome.kind === 'cancelled') return;
        if (outcome.kind !== 'authenticated') {
            // A refused pair keeps the address and clears only the password.
            setDraft((current) => ({ ...current, password: '' }));
            throw 'error' in outcome ? outcome.error : new Error(outcome.kind);
        }
        setDraft(createEmailPasswordDraft(''));
        await props.onSignedIn(outcome);
    }), [draft, focusProblem, props, run]);

    const submitCreate = React.useCallback(() => run(async () => {
        const validated = validateEmailPasswordDraft({ purpose: 'verify_email', draft });
        if (!validated.ok) {
            focusProblem(validated.problem);
            return;
        }
        await requestNativeEmailVerification(publicRequest(), {
            email: validated.normalizedEmail,
            purpose: 'account_service',
        });
        if (!mountedRef.current) return;
        setResent(view.kind === 'create_sent');
        setView({ kind: 'create_sent', email: validated.email });
    }), [draft, focusProblem, publicRequest, run, view.kind]);

    const submitReset = React.useCallback(() => run(async () => {
        const validated = validateEmailPasswordDraft({ purpose: 'verify_email', draft });
        if (!validated.ok) {
            focusProblem(validated.problem);
            return;
        }
        await requestNativePasswordReset(publicRequest(), validated.email);
        if (!mountedRef.current) return;
        setResent(view.kind === 'reset_sent');
        setView({ kind: 'reset_sent', email: validated.email });
    }), [draft, focusProblem, publicRequest, run, view.kind]);

    const emailInvalid = problem?.field === 'email' && problemMessage !== null;
    const emailErrorId = 'account-service-password-email-error';
    const emailField = (autoComplete: 'email' | 'username', onSubmitEditing: () => void) => (
        <FieldItem label={t('settingsAccount.nativePassword.email')}>
            <TextInput
                ref={emailRef as never}
                testID="account-service-password-email"
                accessibilityLabel={t('settingsAccount.nativePassword.email')}
                aria-invalid={problem?.field === 'email'}
                aria-describedby={emailInvalid ? emailErrorId : undefined}
                style={[styles.input, {
                    color: theme.colors.text.primary,
                    borderColor: emailInvalid ? theme.colors.status.error : theme.colors.border.default,
                }]}
                value={draft.email}
                onChangeText={(email) => setDraft((current) => ({ ...current, email }))}
                placeholder={t('settingsAccount.nativePassword.emailPlaceholder')}
                placeholderTextColor={theme.colors.text.secondary}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                keyboardType="email-address"
                inputMode="email"
                autoComplete={autoComplete}
                textContentType="username"
                editable={!busy}
                returnKeyType={view.kind === 'sign_in' ? 'next' : 'go'}
                submitBehavior="submit"
                onSubmitEditing={onSubmitEditing}
            />
            {emailInvalid ? (
                <Text testID={emailErrorId} nativeID={emailErrorId} accessibilityRole="alert" accessibilityLiveRegion="polite"
                    style={[styles.fieldError, { color: theme.colors.status.error }]}>{problemMessage}</Text>
            ) : null}
        </FieldItem>
    );
    // A problem whose field this view does not render shows at the form, never dropped.
    const formProblem = problemMessage && problem?.field !== 'email' && !(view.kind === 'sign_in' && problem?.field === 'password') ? (
        <View style={styles.notice}>
            <Icon name="warning" size={16} color={theme.colors.status.error} />
            <Text testID="account-service-password-form-error" accessibilityRole="alert" accessibilityLiveRegion="polite"
                style={[styles.noticeText, { color: theme.colors.status.error }]}>{problemMessage}</Text>
        </View>
    ) : null;
    const cancel = (
        <RoundButton
            testID="account-service-password-cancel"
            size="small"
            display="inverted"
            title={t('common.cancel')}
            textStyle={{ color: theme.colors.text.secondary }}
            onPress={() => { abortRef.current?.abort(); props.onCancel(); }}
        />
    );
    const sentNotice = (testID: string, body: string, onResend: () => void, onChange: () => void) => (
        <>
            <View style={styles.notice} testID={testID}>
                <Icon name="envelope" size={16} color={theme.colors.text.secondary} />
                <Text accessibilityLiveRegion="polite" style={styles.noticeText}>
                    {resent ? `${body} ${t('settingsAccount.nativePassword.resent')}` : body}
                </Text>
            </View>
            {formProblem}
            <View style={styles.actions}>
                <RoundButton testID="account-service-password-resend" size="small" display="secondary"
                    title={t('settingsAccount.nativePassword.resend')} loading={busy} disabled={busy} onPress={onResend} />
                <RoundButton testID="account-service-password-change-email" size="small" display="inverted"
                    title={t('settingsAccount.nativePassword.useDifferentEmail')} textStyle={{ color: theme.colors.text.secondary }}
                    disabled={busy} onPress={onChange} />
                {cancel}
            </View>
        </>
    );

    if (view.kind === 'create_sent') {
        return (
            <View style={styles.body} testID="account-service-password-create-sent">
                <EmailPasswordSetupSteps step="confirm" inset={false} testID="account-service-password-steps"
                    hint={t('settingsAccount.nativePassword.verificationSent', { email: view.email })} />
                {sentNotice('account-service-password-check-email', t('settingsAccount.nativePassword.checkYourEmail'),
                    () => { void submitCreate(); }, () => { setResent(false); setView({ kind: 'create' }); })}
            </View>
        );
    }
    if (view.kind === 'reset_sent') {
        return (
            <View style={styles.body} testID="account-service-password-reset-sent">
                {sentNotice('account-service-password-check-email',
                    t('settingsAccount.nativePassword.resetInstructionsSent', { email: view.email }),
                    () => { void submitReset(); }, () => { setResent(false); setView({ kind: 'forgot' }); })}
            </View>
        );
    }
    if (view.kind === 'create') {
        return (
            <View style={styles.body} testID="account-service-password-create">
                <EmailPasswordSetupSteps step="email" inset={false} testID="account-service-password-steps"
                    hint={t('settingsAccount.accountServiceCreateExplanation', { accountService: props.serviceName })} />
                <View style={styles.fields}>{emailField('email', () => { void submitCreate(); })}</View>
                {formProblem}
                <View style={styles.actions}>
                    <RoundButton testID="account-service-password-send-confirmation" size="small"
                        title={t('settingsAccount.nativePassword.sendVerification')} loading={busy} disabled={busy}
                        onPress={() => { void submitCreate(); }} />
                    {cancel}
                </View>
            </View>
        );
    }
    if (view.kind === 'forgot') {
        return (
            <View style={styles.body} testID="account-service-password-forgot">
                <Text style={styles.noticeText}>{t('settingsAccount.accountServiceForgotExplanation', { accountService: props.serviceName })}</Text>
                <View style={styles.fields}>{emailField('email', () => { void submitReset(); })}</View>
                {formProblem}
                <View style={styles.actions}>
                    <RoundButton testID="account-service-password-send-reset" size="small"
                        title={t('settingsAccount.nativePassword.emailResetInstructions')} loading={busy} disabled={busy}
                        onPress={() => { void submitReset(); }} />
                    <RoundButton testID="account-service-password-back" size="small" display="inverted"
                        title={t('settingsAccount.nativePassword.returnToSignIn')} textStyle={{ color: theme.colors.text.secondary }}
                        disabled={busy} onPress={() => { setProblem(null); setView({ kind: 'sign_in' }); }} />
                </View>
            </View>
        );
    }
    return (
        <View style={styles.body} testID="account-service-password-sign-in">
            <View style={styles.fields}>
                {emailField('username', () => passwordRef.current?.focus())}
                <PasswordField
                    testID="account-service-password-password"
                    inputRef={passwordRef}
                    label={t('settingsAccount.nativePassword.password')}
                    value={draft.password}
                    onChangeText={(password) => setDraft((current) => ({ ...current, password }))}
                    autoComplete="current-password"
                    error={problem?.field === 'password' ? problemMessage : null}
                    editable={!busy}
                    returnKeyType="go"
                    onSubmitEditing={() => { void submitSignIn(); }}
                />
            </View>
            {formProblem}
            <View style={styles.actions}>
                <RoundButton testID="account-service-password-submit" size="small"
                    title={t('settingsAccount.nativePassword.signIn')} loading={busy} disabled={busy}
                    onPress={() => { void submitSignIn(); }} />
                {canReset ? (
                    <RoundButton testID="account-service-password-forgot" size="small" display="inverted"
                        title={t('settingsAccount.nativePassword.forgotPassword')} textStyle={{ color: theme.colors.text.secondary }}
                        disabled={busy} onPress={() => { setProblem(null); setView({ kind: 'forgot' }); }} />
                ) : null}
                {cancel}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    body: { gap: 14 },
    // Text fields stay a readable width on wide pages instead of spanning the sheet.
    fields: { gap: theme.space.s12, maxWidth: 480, width: '100%' },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space.s8 },
    notice: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s8, maxWidth: 560 },
    noticeText: { flex: 1, fontSize: 14, lineHeight: 20, color: theme.colors.text.secondary },
    fieldError: { fontSize: 12, marginTop: theme.space.s4 },
    input: {
        borderWidth: 1,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s10,
        minHeight: 44,
    },
}));
