import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import type { ApprovalRequest } from '@happier-dev/protocol';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { describeApprovalRequestFields, listActionSpecs, resolveApprovalRequestApproveAdmission } from '@happier-dev/protocol/actions';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Modal } from '@/modal';
import { buildPermissionToolCallRoute, canOpenPermissionToolCallRoute } from '@/utils/sessions/permissions/buildPermissionToolCallRoute';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { ApprovalDecisionFooter } from './ApprovalDecisionFooter';
import { ApprovalPromptChrome } from './ApprovalPromptChrome';
import { getApprovalDecisionErrorMessage, isApprovalReplayRouteUnavailable, presentApprovalFailure, useApprovalDecisionHandler, useApprovalHome } from './useApprovalDecisionHandler';
import { Icon } from '@/components/ui/icons/Icon';
import { ActionApprovalFieldsCard } from '@/components/approvals/ActionApprovalFieldsCard';
import { PromptDocApprovalDiff, readPromptDocUpdateApproval } from '@/components/approvals/PromptDocApprovalDiff';
import { ComputerActionApprovalCard } from '@/components/approvals/ComputerActionApprovalCard';
import {
    ProjectCommandApprovalFacts,
    describeProjectCommandApprovalDecisions,
    readProjectCommandApproval,
    useProjectCommandApprovalTitle,
} from '@/components/approvals/ProjectCommandApprovalFacts';
import { useComputerApprovalChoice } from '@/components/approvals/useComputerApprovalChoice';
import { isConfidentialSecretApprovalAction, readConfidentialSecretApproval } from '@/components/approvals/confidentialSecretApprovalModel';
import { ResourceProposalBody, ResourceProposalModeChip } from '@/components/approvals/resourceProposal/ResourceProposalBody';
import { useResourceProposalApprovalMode } from '@/components/approvals/resourceProposal/useResourceProposalApprovalMode';
import { resolveResourceProposalLabels } from '@/components/approvals/resourceProposal/resourceProposalLabels';
import { useResourceProposalCheck } from '@/components/approvals/resourceProposal/useResourceProposalCheck';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';


type ApprovalPromptCardArtifact = Pick<DecryptedArtifact, 'id' | 'header'>;

function getPreviewSummary(preview: unknown): string | null {
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null;
    const summary = typeof (preview as { summary?: unknown }).summary === 'string'
        ? (preview as { summary: string }).summary.trim()
        : '';
    return summary || null;
}

function resolveDeferredComputerPicker() {
    return (require('../../../computer/openComputerTargetPickerForSession') as typeof import('../../../computer/openComputerTargetPickerForSession')).openComputerTargetPickerForSession;
}

function resolveActionTitle(approval: ApprovalRequest): string {
    return listActionSpecs().find((spec) => spec.id === approval.actionId)?.title || approval.actionId;
}

export const ApprovalPromptCard = React.memo(function ApprovalPromptCard(props: Readonly<{
    artifact: ApprovalPromptCardArtifact;
    approval: ApprovalRequest;
    sessionId: string;
    metadata?: Metadata | null;
    location?: PermissionToolCallMessageLocation | null;
    canApprovePermissions?: boolean;
    canApprove?: boolean;
    disabledReason?: TranscriptPermissionDisabledReason;
    chrome?: 'card' | 'inline';
}>) {
    const { theme } = useUnistyles();
    const transcriptSource = useSessionTranscriptSource();
    const decide = useApprovalDecisionHandler(props.artifact, props.approval, props.sessionId);
    const approvalHome = useApprovalHome(props.artifact, props.approval, props.sessionId);
    const [isDeciding, setIsDeciding] = React.useState(false);
    const chrome = props.chrome ?? 'card';
    const actionTitle = React.useMemo(() => resolveActionTitle(props.approval), [props.approval]);
    const previewSummary = React.useMemo(() => getPreviewSummary(props.approval.preview), [props.approval.preview]);
    const approveAdmission = React.useMemo(
        () => props.approval.status === 'open' ? resolveApprovalRequestApproveAdmission(props.approval) : null,
        [props.approval],
    );
    const executionFailure = React.useMemo(
        () => readApprovalExecutionFailure(props.approval),
        [props.approval],
    );
    const executionFailurePresentation = React.useMemo(
        () => executionFailure ? presentApprovalFailure(executionFailure, executionFailure.error) : null,
        [executionFailure],
    );
    const confidentialAction = isConfidentialSecretApprovalAction(props.approval.actionId);
    const confidentialApproval = readConfidentialSecretApproval(props.approval);
    const actionFields = React.useMemo(() => confidentialAction ? null
        : approveAdmission?.presentation ?? describeApprovalRequestFields(props.approval), [confidentialAction, approveAdmission, props.approval]);
    // An agent's finite Project command reads as its exact command, target and identity (lab `s-agent` ADHOC).
    const projectCommand = React.useMemo(() => readProjectCommandApproval(props.approval), [props.approval]);
    const projectCommandTitle = useProjectCommandApprovalTitle(projectCommand);
    const projectCommandDecisions = projectCommand ? describeProjectCommandApprovalDecisions(projectCommand) : null;
    // An Agent's instructions edit reads as its diff against the current document (lab `b-work P`).
    const promptDocUpdate = React.useMemo(() => readPromptDocUpdateApproval(props.approval), [props.approval]);
    const sessionId = props.sessionId;
    const computerChoice = useComputerApprovalChoice({
        artifactId: props.artifact.id,
        actionId: String(props.approval.actionId),
        actionArgs: props.approval.actionArgs,
        approvedInput: props.approval.v === 2 && props.approval.status !== 'open' && props.approval.decision?.kind === 'approve'
            ? props.approval.decision.narrowedInput : undefined,
        preview: props.approval.preview,
        sessionId,
        serverId: transcriptSource.serverId,
        // Loaded on the press: the picker reads the Session and the store, which this card never does.
        resolveOpenPicker: resolveDeferredComputerPicker,
    });
    const computerAction = computerChoice.presentation;
    const chooseComputerTarget = computerChoice.chooseTarget;
    // An agent's cleanup or stop proposal is this approval's body (plan 60 AGW-6): check on view, pick some.
    const proposal = useResourceProposalCheck(props.approval, approvalHome.serverId, props.artifact.id);
    const proposalLabels = proposal ? resolveResourceProposalLabels(proposal) : null;
    const proposalMode = useResourceProposalApprovalMode(props.approval);
    const approvalWithheld = confidentialAction ? confidentialApproval === null || transcriptSource.navigate === null
        : approveAdmission?.status === 'unavailable' || Boolean(proposal?.approveWithheld);
    const sourceInteraction = transcriptSource.useInteraction();
    const canApprove = transcriptSource.actions !== null
        && (props.canApprovePermissions ?? props.canApprove ?? sourceInteraction.canApprovePermissions)
        && sourceInteraction.canApprovePermissions;
    const approvalRouteUnavailable = isApprovalReplayRouteUnavailable(props.approval);
    const accessDisabled = !canApprove || Boolean(props.disabledReason);
    const decisionDisabled = accessDisabled || approvalRouteUnavailable;
    const canOpenToolRoute = transcriptSource.navigate !== null && canOpenPermissionToolCallRoute(props.location ?? null);

    const onViewTool = React.useCallback(() => {
        navigateWithBlurOnWeb(() => {
            transcriptSource.navigate?.(buildPermissionToolCallRoute({ sessionId: props.sessionId, location: props.location ?? null }));
        });
    }, [props.location, props.sessionId, transcriptSource]);

    const onDecision = React.useCallback(async (decision: 'approve' | 'reject', choice?: Readonly<{ keepUndo?: boolean }>) => {
        if (decisionDisabled || isDeciding || (decision === 'approve' && approvalWithheld)) return;
        if (decision === 'approve' && confidentialAction) {
            if (!confidentialApproval || !transcriptSource.navigate) return;
            const home = confidentialApproval.expectedServerIdentityId ?? confidentialApproval.request.serverId;
            navigateWithBlurOnWeb(() => transcriptSource.navigate?.(`/inbox/approvals/${encodeURIComponent(props.artifact.id)}?serverId=${encodeURIComponent(home)}`));
            return;
        }
        try {
            setIsDeciding(true);
            // An agent's window choice is approved with the exact window the person picked.
            if (decision === 'approve' && computerChoice.needsChoiceBeforeApprove) {
                computerChoice.chooseTarget();
                return;
            }
            const ok = await decide(decision, proposal ? proposal.decisionOptions(decision, choice)
                : decision === 'approve' ? computerChoice.decisionOptions : undefined);
            if (!ok) {
                Modal.alert(t('common.error'), t('approvals.decisionError'));
            }
        } catch (error) {
            Modal.alert(t('common.error'), getApprovalDecisionErrorMessage(error));
        } finally {
            setIsDeciding(false);
        }
    }, [approvalWithheld, confidentialAction, confidentialApproval, computerChoice, decisionDisabled, decide, isDeciding, proposal, props.artifact.id, transcriptSource]);

    if (props.disabledReason === 'inactive') {
        return null;
    }
    // A decided proposal stays in the transcript; declined collapses to its one line (lab `ra` A7·7).
    if (proposal && proposal.display.kind === 'declined' && props.approval.status !== 'open') {
        return <ResourceProposalBody controller={proposal} decisionsAvailable={!decisionDisabled} arrive={false} />;
    }

    return (
        <ApprovalPromptChrome
            testID="approval-prompt-card"
            chrome={chrome}
            title={projectCommandTitle ?? proposalLabels?.title ?? actionTitle}
            titleNumberOfLines={1}
            tone={executionFailure ? 'attention' : undefined}
            subtitle={projectCommand ? null : props.approval.summary || t('approvals.untitled')}
            subtitleNumberOfLines={2}
            headerAccessory={canOpenToolRoute || (proposal && proposalMode && props.approval.status === 'open') ? (
                <View style={styles.headerAccessories}>
                    {proposal && proposalMode && props.approval.status === 'open' ? <ResourceProposalModeChip mode={proposalMode} /> : null}
                    {canOpenToolRoute ? (
                        <Pressable
                            testID="approval-prompt-view-tool"
                            onPress={onViewTool}
                            accessibilityRole="button"
                            accessibilityLabel={t('toolView.open')}
                            style={({ pressed }) => [styles.viewButton, pressed && styles.viewButtonPressed]}
                        >
                            <Icon name="arrow-square-out" size={16} color={theme.colors.text.secondary} />
                        </Pressable>
                    ) : null}
                </View>
            ) : null}
            footer={props.approval.status !== 'open' ? undefined : (
                <ApprovalDecisionFooter
                    approveLabel={confidentialAction ? t('approvals.confidential.review') : projectCommandDecisions?.approve ?? proposalLabels?.approve}
                    rejectLabel={projectCommandDecisions?.reject ?? proposalLabels?.reject}
                    disabled={accessDisabled}
                    decisionDisabled={approvalRouteUnavailable}
                    approveDisabled={approvalWithheld}
                    approveAccessibilityHint={approvalWithheld ? t('approvals.approveUnavailableHint') : undefined}
                    disabledReason={props.disabledReason}
                    isDeciding={isDeciding}
                    onApprove={() => { void onDecision('approve'); }}
                    onReject={() => { void onDecision('reject'); }}
                />
            )}
        >
            {executionFailurePresentation ? (
                <View testID="approval-prompt-execution-failure" accessibilityRole="alert">
                    <Text style={styles.failureText}>{executionFailurePresentation.reason}</Text>
                    {executionFailurePresentation.code ? (
                        <Text style={styles.failureCode}>{executionFailurePresentation.code}</Text>
                    ) : null}
                </View>
            ) : null}
            {previewSummary ? (
                <Text style={styles.previewText}>{previewSummary}</Text>
            ) : null}
            {computerAction ? (
                <ComputerActionApprovalCard
                    presentation={computerAction}
                    onChooseTarget={canApprove ? chooseComputerTarget : undefined}
                    testID="approval-prompt-computer-action"
                />
            ) : null}
            {proposal ? (
                <ResourceProposalBody controller={proposal} decisionsAvailable={!decisionDisabled}
                    arrive={Date.now() - props.approval.createdAtMs < 15_000}
                    onApproveKeepingUndo={() => { void onDecision('approve', { keepUndo: true }); }} />
            ) : projectCommand ? (
                <ProjectCommandApprovalFacts presentation={projectCommand} testID="approval-prompt-project-command" />
            ) : promptDocUpdate ? (
                <PromptDocApprovalDiff request={promptDocUpdate} serverId={transcriptSource.serverId ?? null}
                    sessionId={props.sessionId} testID="approval-prompt-prompt-doc-diff" />
            ) : actionFields && actionFields.rows.length > 0 ? (
                <ActionApprovalFieldsCard presentation={actionFields} serverId={approvalHome.serverId} />
            ) : null}
            {approvalRouteUnavailable ? (
                <Text style={styles.previewText}>{t('actionConfirmations.homeUnavailable')}</Text>
            ) : null}
        </ApprovalPromptChrome>
    );
});

const styles = StyleSheet.create((theme) => ({
    headerAccessories: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    viewButton: {
        minWidth: Platform.select({ ios: 44, default: 48 }),
        minHeight: Platform.select({ ios: 44, default: 48 }),
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
    },
    viewButtonPressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    previewText: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    failureText: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.destructive,
    },
    failureCode: {
        fontSize: 11,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
}));
