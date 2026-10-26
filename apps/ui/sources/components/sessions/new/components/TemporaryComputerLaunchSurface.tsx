import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    isTemporaryComputerLaunchErrorRetryable,
    projectTemporaryComputerLaunchStatus,
    type TemporaryComputerLaunchController,
} from '../hooks/useTemporaryComputerLaunch';
import { isLaunchProfileIncompatibility } from '../modules/profileHelpers';
import { describeRunnerArtifactTarget } from '../hooks/temporaryComputerTargetPresentation';
import type { TemporaryComputerWaitingTarget } from '../hooks/temporaryComputerWaitingTarget';

const progressStates = new Set([
    'reconciling', 'preparing', 'waiting_for_computer', 'waiting_for_approval', 'connected',
    'installing_agent', 'checking_ai_access', 'preparing_encryption', 'creating_session', 'canceling',
]);

export function TemporaryComputerLaunchSurface(props: Readonly<{
    controller: TemporaryComputerLaunchController;
    /**
     * The exact Home, Account and platform this request runs on. It is rendered
     * in every phase: a package already on someone else's computer must never be
     * described only by whatever the composer happens to hold now.
     */
    target?: TemporaryComputerWaitingTarget | null;
    packageExportState?: Readonly<{
        status: 'idle' | 'exporting' | 'failed';
        activationId: string | null;
        error: unknown;
    }>;
    createdOnDeviceLabel?: string | null;
    /**
     * The author's committed expiry for a package whose activation does not exist
     * yet. Once it does, the activation's own frozen instant is authoritative and
     * this is ignored: the waiting surface must never advertise a local intent the
     * Home did not actually record.
     */
    pendingPackageExpiresAt?: number | null;
    /** The package can be exported right now: unclaimed, and custody is on this device. */
    packageAvailableOnThisDevice?: boolean;
    /**
     * This device holds the activation custody for this exact request. It stays
     * true after a claim, which is what keeps the export control mounted and
     * disabled-with-a-reason rather than silently disappearing.
     */
    packageCustodyOnThisDevice?: boolean;
    onExportPackage?: () => Promise<void>;
    onRequestCancel?: () => void;
    /** Leaves the authoring surface mounted while the synchronized draft continues. */
    onContinueLater?: () => void;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const exportPressInFlightRef = React.useRef(false);
    const requestPackageExport = React.useCallback(async () => {
        if (!props.onExportPackage || exportPressInFlightRef.current) return;
        exportPressInFlightRef.current = true;
        try {
            await props.onExportPackage();
        } catch {
            // The mounted creator owner publishes the retryable export failure.
        } finally {
            exportPressInFlightRef.current = false;
        }
    }, [props.onExportPackage]);
    const { status } = props.controller;
    const packageExportFailed = props.packageExportState?.status === 'failed';
    // A server-acknowledged terminal activation has nothing left to cancel; only
    // the local cleanup retry is a real action there. Never render a dead control.
    const terminalCloseReason = props.controller.projection?.state === 'closed'
        ? props.controller.projection.closeReason
        : null;
    const dependencyUnavailable = status === 'review_unavailable' || status === 'materialization_unavailable';
    const observingDependency = dependencyUnavailable && props.packageCustodyOnThisDevice === false;
    const presentedStatus = observingDependency && props.controller.projection
        ? projectTemporaryComputerLaunchStatus(props.controller.projection)
        : status;
    const statusLabel = t(`newSession.temporaryComputer.status.${presentedStatus}` as Parameters<typeof t>[0]);
    // Never is the product default, and "no expiry" is the single most consequential
    // thing this surface can say about a package that is about to leave the device.
    // Silence read as "probably fine"; an exact local date reads as the truth.
    const packageExpiresAt = (props.controller.projection
        ? props.controller.projection.activationExpiresAt
        : props.pendingPackageExpiresAt) ?? null;
    const terminalReasonLabel = terminalCloseReason
        ? t(`newSession.temporaryComputer.closed.${terminalCloseReason}` as Parameters<typeof t>[0])
        : null;
    // iOS has no declarative live-region support (`accessibilityLiveRegion` is
    // Android + web only), so VoiceOver would otherwise stay silent while every
    // declarative test passes. iOS therefore speaks through the shared
    // `PoliteAccessibilityStatus` (rendered below on iOS only), keyed by the
    // semantic phase: it speaks once per phase change, stays silent on refetch,
    // and never re-speaks the phase a reopened request mounts with (it is
    // already on screen). Web and Android keep their declarative live-region
    // priority (assertive for failures, polite otherwise).
    //
    // The composer mounts this surface only after the user presses Launch, so a
    // mount in `preparing` IS the launch starting. The announcer mounts on an idle
    // key and moves to the launch key right after, which makes the launch start
    // the owner's ordinary transition instead of a silent mount state.
    const [launchStartPending, setLaunchStartPending] = React.useState(
        () => Platform.OS === 'ios' && status === 'preparing',
    );
    React.useEffect(() => {
        if (launchStartPending) setLaunchStartPending(false);
    }, [launchStartPending]);
    const announcementTransitionKey = launchStartPending
        ? 'temporary-computer-launch:idle'
        : `${status}|${terminalCloseReason ?? ''}|${packageExportFailed ? 'export-failed' : 'export-ok'}`;
    const iosAnnouncement = terminalReasonLabel ? `${statusLabel}. ${terminalReasonLabel}` : statusLabel;
    if (status === 'idle') return null;
    // The reviewed Profile or its exact target-Account secrets stopped resolving
    // before anything was created. Retrying the frozen submission would repeat
    // the same refusal, so the composer is the only control that can fix it.
    const authoringIncompatible = isLaunchProfileIncompatibility(status);
    const packageExporting = props.packageExportState?.status === 'exporting';
    const failed = status === 'failed' || status === 'cancel_failed'
        || (dependencyUnavailable && !observingDependency) || authoringIncompatible || packageExportFailed;
    const terminalProjection = props.controller.projection?.state === 'materialized'
        || props.controller.projection?.state === 'closed';
    const materializedRecoveryFailure = status === 'failed'
        && props.controller.projection?.state === 'materialized';
    const retryableFailure = ((status === 'failed' && (!terminalProjection || materializedRecoveryFailure)) || status === 'cancel_failed'
        || (dependencyUnavailable && props.packageCustodyOnThisDevice === true))
        && isTemporaryComputerLaunchErrorRetryable(props.controller.error);
    // Nothing is waiting any more once the request has settled, so the expiry of a
    // package that can no longer be claimed is noise rather than information. A
    // refused authoring incompatibility never produced a package to expire.
    const showExpiry = !terminalProjection && status !== 'succeeded' && !authoringIncompatible;
    // Reconciling is deliberately absent: until the canonical projection answers
    // we do not know whether there is anything to cancel, and guessing either way
    // is worse than waiting a moment.
    const canCancel = ['preparing', 'waiting_for_computer', 'review_unavailable', 'waiting_for_approval', 'connected', 'installing_agent', 'checking_ai_access', 'preparing_encryption', 'creating_session', 'materialization_unavailable', 'failed', 'cancel_failed'].includes(status)
        && !terminalProjection;
    // A claimed activation is bound to the computer that claimed it. Re-sending
    // the same package cannot produce a second endpoint, so export is refused
    // here rather than generating another activation identity for one attempt.
    const packageClaimed = props.controller.projection?.claim != null;
    const exportEnabled = status === 'waiting_for_computer'
        && !packageClaimed
        && !packageExporting
        && props.onExportPackage != null;
    // The affordance stays on screen across the claim transition once this device
    // holds the package custody: a claim disables it *with its reason* rather than
    // letting it vanish, which would both hide why re-sending is impossible and
    // drop keyboard focus to nowhere on a phase tick. Export itself is another
    // continuity transition: the mounted button becomes busy instead of being
    // removed while its asynchronous platform action runs.
    const showExportAction = (props.packageCustodyOnThisDevice === true || props.onExportPackage != null)
        && !terminalProjection
        && (exportEnabled || packageExporting || packageClaimed);
    // Custody is device-local and unsynchronized, so another device of the same
    // Account can open this synchronized draft at any point in the lifecycle. It
    // can inspect and cancel, and nothing else — which is exactly what it has to
    // be told. Keying this on `waiting_for_computer` alone removed the guidance
    // at the claim transition, the one moment it is most needed.
    const observingWithoutPackageCustody = props.packageCustodyOnThisDevice !== true
        && props.packageAvailableOnThisDevice === false
        && !terminalProjection
        && status !== 'succeeded';
    // The endpoint seals its folder and host details to the creating Account.
    // Another device — or an Account whose content key has since changed — simply
    // cannot read them, and saying so is better than an empty space where the
    // computer's details should be.
    const endpointFactsUnreadable = props.controller.projection?.endpointFacts?.status === 'unavailable';
    return (
        <View
            testID="temporary-computer-launch-surface"
            // The status lives on the live region below. Repeating it as the
            // container's label makes every screen-reader pass announce the
            // phase twice — once for the card, once for the region.
            style={{
                width: '100%', borderWidth: 1, borderColor: failed ? theme.colors.status.error : theme.colors.border.default,
                backgroundColor: theme.colors.surface.elevated, borderRadius: 12, padding: 14, gap: theme.space.s10,
            }}
        >
            <Text accessibilityRole="header" style={{ color: theme.colors.text.primary }}>
                {t('newSession.temporaryComputer.title')}
            </Text>
            <Text style={{ color: theme.colors.text.secondary }}>
                {t('newSession.temporaryComputer.subtitle')}
            </Text>
            {props.target ? (
                <View testID="temporary-computer-target" style={{ gap: theme.space.s2 }}>
                    <Text testID="temporary-computer-target-platform" style={{ color: theme.colors.text.primary }}>
                        {describeRunnerArtifactTarget(props.target.artifactTarget)}
                    </Text>
                    {props.target.homeLabel ? (
                        <Text testID="temporary-computer-target-home" style={{ color: theme.colors.text.secondary }}>
                            {t('newSession.temporaryComputer.target.home', { home: props.target.homeLabel })}
                        </Text>
                    ) : null}
                    {props.target.accountLabel ? (
                        <Text testID="temporary-computer-target-account" style={{ color: theme.colors.text.secondary }}>
                            {t('newSession.temporaryComputer.target.account', { account: props.target.accountLabel })}
                        </Text>
                    ) : null}
                    {props.target.workspace ? (
                        <Text testID="temporary-computer-target-workspace" style={{ color: theme.colors.text.secondary }}>
                            {props.target.workspace === 'endpoint_home'
                                ? t('newSession.temporaryComputer.target.workspaceHome')
                                : t('newSession.temporaryComputer.target.workspaceChoose')}
                        </Text>
                    ) : null}
                </View>
            ) : null}
            {Platform.OS === 'ios' ? (
                <PoliteAccessibilityStatus
                    announcement={iosAnnouncement}
                    statusTestID="temporary-computer-launch-ios-announcement"
                    transitionKey={announcementTransitionKey}
                />
            ) : null}
            <View
                testID="temporary-computer-launch-progress"
                accessibilityRole={progressStates.has(status) ? 'progressbar' : undefined}
                accessibilityLabel={statusLabel}
                accessibilityLiveRegion={Platform.OS === 'ios' ? undefined : failed ? 'assertive' : 'polite'}
                style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}
            >
                {progressStates.has(status) ? <ActivitySpinner size="small" color={theme.colors.text.secondary} /> : null}
                <Text testID="temporary-computer-launch-status" style={{ color: failed ? theme.colors.status.error : theme.colors.text.primary }}>
                    {statusLabel}
                </Text>
            </View>
            {showExpiry ? (
                <Text testID="temporary-computer-package-expiry" style={{ color: theme.colors.text.secondary }}>
                    {packageExpiresAt === null
                        ? t('newSession.temporaryComputer.expiry.noExpiry')
                        : t('newSession.temporaryComputer.expiry.expiresAt', {
                            date: new Date(packageExpiresAt).toLocaleString(),
                        })}
                </Text>
            ) : null}
            {endpointFactsUnreadable ? (
                <Text testID="temporary-computer-endpoint-facts-unreadable" style={{ color: theme.colors.text.secondary }}>
                    {t('newSession.temporaryComputer.endpointFacts.unreadable')}
                </Text>
            ) : null}
            {terminalCloseReason && terminalReasonLabel ? (
                <Text testID="temporary-computer-terminal-reason" style={{ color: theme.colors.text.secondary }}>
                    {terminalReasonLabel}
                </Text>
            ) : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 }}>
                {showExportAction ? (
                    <Action
                        testID="temporary-computer-export"
                        label={t('newSession.temporaryComputer.exportPackage')}
                        disabled={!exportEnabled}
                        busy={packageExporting}
                        onPress={() => { void requestPackageExport(); }}
                    />
                ) : null}
                {authoringIncompatible ? (
                    <Action
                        testID="temporary-computer-return-to-editing"
                        label={t('newSession.temporaryComputer.returnToEditing')}
                        onPress={props.controller.dismissTerminal}
                    />
                ) : null}
                {retryableFailure ? <Action testID="temporary-computer-retry" label={t('common.retry')} onPress={() => void props.controller.retry()} /> : null}
                {props.onContinueLater && (!terminalProjection || materializedRecoveryFailure) && status !== 'succeeded' ? (
                    <Action
                        testID="temporary-computer-continue-later"
                        label={t('newSession.temporaryComputer.continueLater')}
                        display="inverted"
                        onPress={props.onContinueLater}
                    />
                ) : null}
                {status === 'failed' && props.controller.projection?.state === 'closed' && terminalCloseReason === 'canceled' ? (
                    <Action
                        testID="temporary-computer-terminal-done"
                        label={t('common.done')}
                        onPress={props.controller.dismissTerminal}
                    />
                ) : null}
                {status === 'failed' && props.controller.projection?.state === 'closed' && terminalCloseReason !== 'canceled' ? (
                    <Action
                        testID="temporary-computer-terminal-new-package"
                        label={t('newSession.temporaryComputer.createNewPackage')}
                        onPress={() => { void props.controller.replaceTerminal(); }}
                    />
                ) : null}
                {canCancel ? (
                    <Action
                        testID="temporary-computer-cancel"
                        label={t('common.cancel')}
                        display="inverted"
                        onPress={props.onRequestCancel ?? (() => { void requestTemporaryComputerLaunchCancel(props.controller); })}
                    />
                ) : null}
            </View>
            {showExportAction && packageClaimed ? (
                <Text testID="temporary-computer-export-claimed" style={{ color: theme.colors.text.secondary }}>
                    {t('newSession.temporaryComputer.exportClaimed')}
                </Text>
            ) : null}
            {packageExportFailed ? (
                <View testID="temporary-computer-package-export-error" style={{ gap: theme.space.s4 }}>
                    <Text style={{ color: theme.colors.status.error }}>
                        {t('newSession.temporaryComputer.status.failed')}
                    </Text>
                    {props.createdOnDeviceLabel ? (
                        <Text testID="temporary-computer-package-export-device" style={{ color: theme.colors.text.secondary }}>
                            {props.createdOnDeviceLabel}
                        </Text>
                    ) : null}
                </View>
            ) : observingWithoutPackageCustody ? (
                // No custody here means this device can neither re-export the
                // package nor be told to prepare one. The two things it can
                // actually do are the two the plan names, and Cancel — which is
                // mounted above for this status — is the second of them.
                <View testID="temporary-computer-package-export-guidance" style={{ gap: theme.space.s4 }}>
                    <Text testID="temporary-computer-other-device-guidance" style={{ color: theme.colors.text.secondary }}>
                        {t('newSession.temporaryComputer.otherDevice.guidance')}
                    </Text>
                    {props.createdOnDeviceLabel ? (
                        // A bare device name read as an unlabelled string here —
                        // and the creator's fallback literally says "This device",
                        // which is false on every other one.
                        <Text testID="temporary-computer-package-export-device" style={{ color: theme.colors.text.secondary }}>
                            {t('newSession.temporaryComputer.otherDevice.createdOn', { device: props.createdOnDeviceLabel })}
                        </Text>
                    ) : null}
                </View>
            ) : null}
        </View>
    );
}

/** The one confirmation-aware dismissal path used by the button and modal boundary. */
export async function requestTemporaryComputerLaunchCancel(
    controller: TemporaryComputerLaunchController,
): Promise<void> {
    const state = controller.projection?.state;
    if (state === 'materialized' || state === 'closed' || controller.status === 'canceling' || controller.status === 'succeeded') {
        return;
    }
    if (state === 'claimed' || state === 'consented') {
        const confirmed = await Modal.confirm(
            t('newSession.temporaryComputer.cancelConnectedTitle'),
            t('newSession.temporaryComputer.cancelConnectedBody'),
            {
                cancelText: t('common.back'),
                confirmText: t('common.cancel'),
                destructive: true,
            },
        );
        if (!confirmed) return;
    }
    await controller.cancel();
}

function Action(props: Readonly<{ testID: string; label: string; disabled?: boolean; busy?: boolean; display?: 'inverted'; onPress: () => void }>): React.ReactElement {
    return <RoundButton
        testID={props.testID}
        title={props.label}
        accessibilityLabel={props.label}
        disabled={props.disabled && !props.busy}
        loading={props.busy}
        display={props.display}
        size="normal"
        titleNumberOfLines="complete"
        style={{ maxWidth: '100%' }}
        onPress={props.onPress}
    />;
}
