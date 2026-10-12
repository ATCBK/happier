import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { SecretKeyEntryForm } from '@/components/account/restore/SecretKeyEntryForm';
import { PairingLinkEntryForm } from '@/components/account/restore/PairingLinkEntryForm';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { parseHomeQrInviteDeepLink } from '@/auth/pairing/pairingUrl';
import { SurfaceStateCard, type SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import { StepTransitionFrame, resolveStepTransitionDirection, type StepTransitionDirection } from '@/components/ui/motion/StepTransitionFrame';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Modal } from '@/modal';
import { t } from '@/text';
import { completeAccountServicePostAuth, confirmAccountServiceHomeRelink, isCompletedAccountPostAuthResult, resumeAccountServicePostAuth, supplyAccountServiceHomeMaterial,
    type AccountPostAuthInput, type AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { getPendingDirectoryHomeEnrollment, subscribePendingDirectoryHomeEnrollment, resumePendingDirectoryHomeEnrollment, cancelPendingDirectoryHomeEnrollment } from '@/sync/ops/accountDirectory/enrollDirectoryHome';
import { useAccountDirectoryActivePolling } from '@/sync/ops/accountDirectory/useAccountDirectoryActivePolling';
import { formatEnrollmentExpiry } from '@/auth/pairing/pairingPresentation';
import { resolveServerProfileForPortableIdentity } from '@/sync/domains/server/serverProfiles';
import { openEnrolledHomeOrReturnToShell } from '@/auth/pairing/openEnrolledHome';
import { useAuth } from '@/auth/context/AuthContext';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { WelcomeActionAdmissionContext } from '@/components/onboarding/preAuth/WelcomeActionList';
import { describeAccountPostAuthResultReason, describeAccountServiceFailure } from './accountServiceFailurePresentation';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';

const loadRestoreScanComputerQrView = () => import('@/components/account/restore/RestoreScanComputerQrView');
const RestoreScanComputerQrView = retryableLazy(async () => ({ default: (await loadRestoreScanComputerQrView()).RestoreScanComputerQrView }));

type RecoveryView = 'key' | 'scan' | 'paste';
/** Recovery views read left to right: the card, its scanner, the scanner's paste form. */
const RECOVERY_VIEW_ORDER: Record<RecoveryView, number> = { key: 0, scan: 1, paste: 2 };

export function AccountServiceContinuation(props: Readonly<{
    input: AccountPostAuthInput;
    result: AccountPostAuthResult;
    onResult: (result: AccountPostAuthResult, input?: AccountPostAuthInput) => void | Promise<void>;
    onBack: () => void;
    onReauthenticate?: (input: AccountPostAuthInput) => void | Promise<void>;
    onOpenHomeAuthentication?: (
        input: AccountPostAuthInput,
        homeServerIdentityId: string,
        previous: AccountPostAuthResult,
    ) => void | Promise<void>;
}>): React.ReactElement {
    const [recovery, setRecovery] = React.useState<Readonly<{ view: RecoveryView; direction: StepTransitionDirection }>>(
        { view: 'key', direction: 'replace' });
    const recoveryView = recovery.view;
    const setRecoveryView = (view: RecoveryView) => setRecovery((current) => current.view === view ? current : {
        view,
        direction: resolveStepTransitionDirection({ previousIndex: RECOVERY_VIEW_ORDER[current.view], nextIndex: RECOVERY_VIEW_ORDER[view] }),
    });
    const router = useRouter();
    const auth = useAuth();
    const [openUnavailable, setOpenUnavailable] = React.useState(false);
    const [pairingLink, setPairingLink] = React.useState<string | null>(null);
    const [approvalStopped, setApprovalStopped] = React.useState(false);
    const admission = React.useContext(WelcomeActionAdmissionContext);
    const inFlight = React.useRef(false);
    const [busy, setBusy] = React.useState(false);
    const run = async (actionId: string, action: () => Promise<void> | void) => {
        if (inFlight.current || props.input.signal?.aborted) return;
        inFlight.current = true;
        setBusy(true);
        try { await admission.run(actionId, action); }
        finally { inFlight.current = false; setBusy(false); }
    };
    const pending = React.useSyncExternalStore(subscribePendingDirectoryHomeEnrollment, getPendingDirectoryHomeEnrollment, getPendingDirectoryHomeEnrollment);
    const ownsPending = pending?.input.session === props.input.session
        && JSON.stringify(pending.input.intent) === JSON.stringify(props.input.intent);
    useAccountDirectoryActivePolling(async () => {
        if (!ownsPending) return 'completed';
        const result = await resumePendingDirectoryHomeEnrollment();
        if (result) await props.onResult(result);
        return result?.kind === 'failure' && result.recovery === 'retry_stage' ? 'backoff' : 'completed';
    }, ownsPending);

    const back = async () => {
        if (ownsPending && pending) await cancelPendingDirectoryHomeEnrollment(pending);
        props.onBack();
    };
    const retry = async () => { await props.onResult(await resumeAccountServicePostAuth(props.input, props.result)); };
    const material = props.result.kind === 'home_material_required' ? props.result : null;
    const failure = props.result.kind === 'failure' ? props.result : null;
    const failurePresentation = failure ? describeAccountServiceFailure(failure.code) : null;
    const successful = isCompletedAccountPostAuthResult(props.result);
    const completedHomeServerIdentityId = successful && 'homeServerIdentityId' in props.result
        ? props.result.homeServerIdentityId
        : undefined;
    const target = material?.homeServerIdentityId ?? failure?.targetHomeServerIdentityId ?? completedHomeServerIdentityId
        ?? (props.result.kind === 'explicit_target_not_linked' || props.result.kind === 'approval_required' ? props.result.homeServerIdentityId : undefined);
    const targetProfile = target ? resolveServerProfileForPortableIdentity(target) : null;
    const verifiedAccountServiceName = props.input.service.snapshot.features.accountServicePresentation?.displayName?.trim() || undefined;
    // Routine copy names the service the user actually chose, never the
    // internal "Account Service" concept. The verified presentation name is the
    // authority; its address is the only honest fallback.
    const serviceDisplayName = verifiedAccountServiceName ?? toServerUrlDisplay(props.input.service.endpointUrl);
    const homeName = props.input.session.snapshot.homes.find((home) => home.homeServerIdentityId === target)?.label
        ?? (targetProfile?.kind === 'resolved' ? resolveHomeDisplayLabel(targetProfile.profile, targetProfile.profile.id) : t('common.homeProductName'));
    const openHomeGenerationRef = React.useRef(0);
    React.useEffect(() => () => {
        openHomeGenerationRef.current += 1;
    }, []);
    const paired = material ? async (value: Parameters<typeof supplyAccountServiceHomeMaterial>[2]) => {
        const result = await supplyAccountServiceHomeMaterial(props.input, material, value);
        setRecoveryView('key');
        setPairingLink(null);
        await props.onResult(result);
    } : undefined;

    const expired = failure?.code.source === 'home' && failure.code.code === 'expired';
    // A declined approval is as legitimately restartable as an expired one: the
    // other device answered, so a fresh attempt is the allowed distinct action.
    const approvalRejected = (failure?.code.source === 'home' && failure.code.code === 'rejected')
        || (failure?.code.source === 'directory' && failure.code.code === 'approval_rejected');
    const restartable = expired || approvalRejected;
    const canRetry = failure?.recovery === 'retry_stage';
    const noHomes = props.result.kind === 'account_connected_no_homes';
    const explicitTargetNotLinked = props.result.kind === 'explicit_target_not_linked';
    const directHomeAuthentication = target && props.onOpenHomeAuthentication
        && (failure?.recovery === 'use_home_auth' || explicitTargetNotLinked)
        ? () => run('direct-home-auth', () => props.onOpenHomeAuthentication!(props.input, target, props.result))
        : null;
    const offersScan = material !== null || noHomes || explicitTargetNotLinked || failure?.recovery === 'use_home_auth';
    // Offering scan means the next press mounts the lazy scanner; load it now so
    // the recovery view slides in instead of flashing a spinner.
    React.useEffect(() => {
        if (offersScan) void loadRestoreScanComputerQrView().catch(() => undefined);
    }, [offersScan]);
    const canOpenEnrolledHome = props.result.kind === 'home_enrolled' && targetProfile?.kind === 'resolved' && !openUnavailable;
    const stopWaiting = async () => {
        if (ownsPending && pending) await cancelPendingDirectoryHomeEnrollment(pending);
        setApprovalStopped(true);
    };
    const relink = async () => {
        const confirmed = await Modal.confirm(
            t('settingsAccount.accountServiceRelinkConfirmTitle', { accountService: verifiedAccountServiceName }),
            t('settingsAccount.accountServiceRelinkConfirmBody', { accountService: verifiedAccountServiceName }),
            { confirmText: t('common.continue'), cancelText: t('common.cancel') });
        if (confirmed) await props.onResult(await confirmAccountServiceHomeRelink(props.input));
    };
    const openEnrolledHome = async () => {
        if (props.result.kind !== 'home_enrolled') return;
        const profile = resolveServerProfileForPortableIdentity(props.result.homeServerIdentityId);
        if (profile.kind !== 'resolved') {
            // The saved profile went away after enrollment: nothing can be
            // opened, so the card stops offering it rather than doing nothing.
            setOpenUnavailable(true);
            return;
        }
        const generation = openHomeGenerationRef.current + 1;
        openHomeGenerationRef.current = generation;
        const isCurrent = () => generation === openHomeGenerationRef.current && props.input.signal?.aborted !== true;
        const outcome = await openEnrolledHomeOrReturnToShell({
            profileId: profile.profile.id,
            targetLabel: homeName,
            isCurrent,
            refreshAuth: auth.refreshFromActiveServer,
        });
        if (outcome !== 'opened' || !isCurrent()) return;
        // An opened Home lands on the shell showing it. A declined retry
        // ('returned_to_shell') keeps this card, so Open and Back stay available.
        router.replace('/');
    };
    const scanOrPaste: SurfaceStateAction = { label: t('connect.scanExistingHomeQrTitle'), onPress: () => setRecoveryView('scan') };
    const signInToHome: SurfaceStateAction | null = directHomeAuthentication
        ? { label: t('settingsAccount.accountServiceOAuth.notLinked.signInAction', { homeName }), onPress: directHomeAuthentication }
        : null;
    const refresh: SurfaceStateAction = { label: t('common.refresh'), onPress: async () => { await props.onResult(await completeAccountServicePostAuth(props.input)); } };
    const backAction: SurfaceStateAction = { label: t('common.back'), onPress: back };

    let content: React.ReactElement;
    if (recoveryView === 'paste') {
        content = <PairingLinkEntryForm onBack={() => setRecoveryView('scan')} onSubmit={async (link) => {
            if (!parseHomeQrInviteDeepLink(link, target ? { homeServerIdentityId: target, direction: 'trusted_home_displays' } : undefined)) return false;
            setPairingLink(link);
            setRecoveryView('scan');
            return true;
        }} />;
    } else if (recoveryView === 'scan') {
        content = <React.Suspense fallback={<ActivitySpinner />}><RestoreScanComputerQrView embedded
            entryIntent="add_home"
            expectedHomeServerIdentityId={target} initialPairingLink={pairingLink}
            onCredentials={paired} onBack={() => { setPairingLink(null); setRecoveryView('key'); }}
            onAuthenticated={material ? undefined : async (authenticatedHome) => {
                const result = await resumeAccountServicePostAuth(props.input, props.result, authenticatedHome);
                setRecoveryView('key');
                setPairingLink(null);
                await props.onResult(result);
            }}
            onOpenSecretKeyLogin={material ? () => setRecoveryView('key') : undefined}
            onOpenPairingLinkEntry={() => setRecoveryView('paste')} /></React.Suspense>;
    } else if (material) {
        content = <View>
            <SecretKeyEntryForm description={t('welcome.accountKeyDescription', { service: homeName })}
                submitTitle={t('welcome.accountKeySubmit')} onBack={() => { void back(); }}
                secondaryAction={{ label: scanOrPaste.label, onPress: () => { void scanOrPaste.onPress(); } }}
                onSubmit={async ({ secret }) => {
                    const result = await supplyAccountServiceHomeMaterial(props.input, material, secret);
                    await props.onResult(result);
                    return { kind: result.kind === 'home_material_required' ? 'invalid_key' : result.kind === 'failure' ? 'failed' : 'completed' };
                }} />
        </View>;
    } else if (props.result.kind === 'choose_home') {
        content = <View>
            {/*
              * Offline Homes stay eligible (R-DIRECTORY forbids filtering to
              * manufacture a sole choice), so the row itself has to carry the
              * address and the preferred hint — otherwise identically labelled
              * Homes are indistinguishable and the user picks blind.
              */}
            <ActionListSection actions={props.result.homes.map((home) => ({
                id: home.homeServerIdentityId,
                testID: `account-service-choose-home-${home.homeServerIdentityId}`,
                label: home.label,
                subtitle: home.preferred
                    ? `${home.canonicalServerUrl} · ${t('settingsAccount.accountServicePreferredHome')}`
                    : home.canonicalServerUrl,
                disabled: busy || admission.pendingActionId !== null,
                onPress: () => run(home.homeServerIdentityId, async () => {
                    const input: AccountPostAuthInput = { ...props.input,
                        intent: { kind: 'enter', target: { kind: 'explicit', homeServerIdentityId: home.homeServerIdentityId } } };
                    await props.onResult(await completeAccountServicePostAuth(input), input);
                }),
            }))} />
            <RoundButton title={t('common.back')} onPress={back} />
        </View>;
    } else if (props.result.kind === 'approval_required' && approvalStopped) {
        // Stopping the wait is not the same as leaving: the Account sign-in survives
        // it, and the user cannot tell that from an immediate dismissal.
        content = <SurfaceStateCard testID="account-service-approval-stopped" kind="warning"
            title={t('settingsAccount.accountServiceOAuth.approvalWait.cancelledTitle')}
            reason={t('settingsAccount.accountServiceOAuth.approvalWait.cancelledBody')}
            accessibilitySemantics="status"
            action={{ label: t('common.back'), onPress: props.onBack }} />;
    } else {
        // One card, one obvious primary: every alternative is the card's own
        // secondary action, never a heavier bare button beneath it.
        const [action, secondaryAction]: readonly [SurfaceStateAction, SurfaceStateAction?] = restartable
            ? [{ label: t('settingsAccount.accountServiceOAuth.actions.startAgain'), onPress: refresh.onPress }]
            : canRetry ? [{ label: t('common.retry'), onPress: retry }]
            : failure?.recovery === 'reauthenticate_account' && props.onReauthenticate
                ? [{ label: t('common.continue'), onPress: () => run('reauthenticate', () => props.onReauthenticate!(props.input)) }]
            : failure?.recovery === 'relink_home' ? [{ label: t('settingsAccount.accountServiceLinkThisHome'), onPress: relink }]
            : failure?.recovery === 'use_home_auth' ? (signInToHome ? [signInToHome, scanOrPaste] : [scanOrPaste])
            : props.result.kind === 'approval_required' ? [{ label: t('approvals.stopWaiting'), onPress: stopWaiting }]
            : canOpenEnrolledHome
                ? [{ label: t('settingsAccount.accountServiceOAuth.actions.openHome', { homeName }), onPress: openEnrolledHome }, backAction]
            : successful ? [{ label: t('common.done'), onPress: back }]
            : noHomes ? [refresh, scanOrPaste]
            : explicitTargetNotLinked ? (signInToHome ? [signInToHome, scanOrPaste] : [scanOrPaste])
            : [backAction];
        content = <View><SurfaceStateCard testID={`account-service-continuation-${props.result.kind}`}
            kind={failure ? 'error' : successful ? 'success' : 'warning'}
            title={props.result.kind === 'approval_required' ? t('settingsAccount.accountServiceOAuth.stages.waitingApproval')
                : props.result.kind === 'account_connected'
                    ? t('settingsAccount.accountServiceSignedInTo', { accountService: serviceDisplayName })
                    : successful ? t('settingsAccount.accountServiceOAuth.success.title', { homeName })
                    : noHomes ? t('settingsAccount.accountServiceSignedInTo', { accountService: serviceDisplayName })
                        : explicitTargetNotLinked ? t('settingsAccount.accountServiceOAuth.notLinked.title', { homeName })
                        : failurePresentation ? failurePresentation.title : t('common.error')}
            reason={describeAccountPostAuthResultReason(props.result, { signInToHome: signInToHome !== null, homeName })}
            {...(props.result.kind === 'approval_required'
                ? { detail: `${homeName} · ${formatEnrollmentExpiry(props.result.expiresAtMs)}` }
                : {})}
            accessibilitySemantics={failure ? 'alert' : 'status'}
            action={action}
            {...(secondaryAction ? { secondaryAction } : {})} />
        </View>;
    }
    return <StepTransitionFrame transitionKey={recoveryView} direction={recovery.direction}>{content}</StepTransitionFrame>;
}
