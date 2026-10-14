import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter, type Href } from 'expo-router';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import { approvalArtifactBodyMatchesHeaderV1, buildExecutionRunHostActionApprovalArtifactHeaderV1, buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { ExecutionRunHostActionApprovalRequestV1Schema, type ExecutionRunHostActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/executionRunHostActionApprovalRequestV1';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { WorkspaceSyncConflictResolutionResultV1Schema, WorkspaceSyncConflictResolutionV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ApprovalDecisionBar } from './ApprovalDecisionBar';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { useApprovalArtifact } from './useApprovalArtifact';
import { captureActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import {
  storage,
  useServerScopedMachine,
  useSessionListRenderableWithServerScope,
} from '@/sync/domains/state/storage';
import {
  replayApprovalRequestAtExactDaemon,
} from '@/sync/ops/actions/defaultActionExecutor';
import { readDisplayMachineIdForSession } from '@/sync/ops/sessionMachineTarget';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { ApprovalSessionContextCard } from './ApprovalSessionContextCard';
import { resolveApprovalHomeName } from './approvalRequesterLabels';
import { ActionApprovalFieldsCard } from './ActionApprovalFieldsCard';
import {
  ProjectCommandApprovalFacts,
  describeProjectCommandApprovalDecisions,
  readProjectCommandApproval,
  useProjectCommandApprovalTitle,
} from './ProjectCommandApprovalFacts';
import { resolveApprovalRequestTitle } from './approvalRequestTitle';
import { WorkspaceSyncConflictDetailsView } from '@/components/workspaces/sync/WorkspaceSyncConflictDetailsView';
import { describeApprovalRequestFields, resolveApprovalRequestApproveAdmission } from './approvalFieldValues';
import { ApprovalPreviewCard, readApprovalPreviewSummary } from './ApprovalPreviewCard';
import { ApprovalVisualPreview } from './ApprovalVisualPreview';
import { resolveApprovalVisualPreview } from './approvalFieldValues';
import { HandoffTargetConsequencesCard, describeHandoffTargetApproval } from './HandoffTargetConsequencesCard';
import { ComputerActionApprovalCard } from './ComputerActionApprovalCard';
import { ResourceProposalBody } from './resourceProposal/ResourceProposalBody';
import { resolveResourceProposalLabels } from './resourceProposal/resourceProposalLabels';
import { useResourceProposalCheck } from './resourceProposal/useResourceProposalCheck';
import { ConfidentialSecretApproval } from './ConfidentialSecretApproval';
import { isConfidentialSecretApprovalAction, readConfidentialSecretApproval } from './confidentialSecretApprovalModel';
import { useComputerApprovalChoice } from './useComputerApprovalChoice';
import { openComputerTargetPickerForSession } from '@/components/computer/openComputerTargetPickerForSession';

import { SessionStoredImageThumbnail } from '@/components/sessions/media/SessionStoredImageThumbnail';
import { readApprovalSessionEndpointLabels, readApprovalTargetEndpointLabels } from './approvalEndpointLabels';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import {
  getApprovalDecisionErrorMessage,
  isApprovalDecisionStale,
  isApprovalReplayRouteUnavailable,
  resolveApprovalReplayRoute,
  useApprovalDecisionHandler,
} from '@/components/tools/shell/approvals/useApprovalDecisionHandler';
import { useRetargetNavigationFocusReturnIntent } from '@/keyboard/focusReturn';
import { useSessionListHomeObservations } from '@/sync/store/hooks';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import {
  buildSessionContextFacts,
  projectSessionContextPresentation,
} from '@/sync/domains/session/presentation/sessionContextPresentation';

/** The picker opener for this page's computer approvals (the page already holds the store). */
const resolveComputerPicker = () => openComputerTargetPickerForSession;

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface.base,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.space.s24,
  },
  recoveryActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: theme.space.s12,
    marginTop: theme.space.s12,
  },
}));

function formatApprovalStatusLabel(status: string): string {
  switch (status) {
    case 'open':
      return t('approvals.status.open');
    case 'approved':
      return t('approvals.status.approved');
    case 'executing':
      return t('approvals.status.executing');
    case 'rejected':
      return t('approvals.status.rejected');
    case 'executed':
      return t('approvals.status.executed');
    case 'failed':
      return t('approvals.status.failed');
    case 'canceled':
      return t('approvals.status.canceled');
    default:
      return status;
  }
}

export const ApprovalDetailScreen = React.memo((props: Readonly<{
  artifactId: string;
  serverId?: string;
  completionHref?: Href;
  completionFocusFrom?: string;
  completionFocusTo?: string;
  /** Where "Back" goes when the request cannot be shown: the host closes its pane (the Inbox's detail); a route goes back. */
  onBack?: () => void;
}>) => {
  const router = useRouter();
  const goBack = props.onBack ?? router.back;
  const retargetNavigationFocusReturn = useRetargetNavigationFocusReturnIntent();
  const { theme } = useUnistyles();
  // A route-carried Home is authoritative for background Homes. Without one,
  // retain the incumbent singleton artifact reader; an unrelated active Home
  // is not evidence that this artifact belongs there.
  const [requestedServerId] = React.useState(() => props.serverId?.trim() || null);
  const {
    artifact,
    isLoading,
    homeUnavailable,
    error: loadError,
    refresh: refreshArtifact,
  } = useApprovalArtifact({
    artifactId: props.artifactId, serverId: requestedServerId,
  });
  const error = loadError
    ? homeUnavailable
      ? t('actionConfirmations.homeUnavailable')
      : t('approvals.loadError')
    : null;
  const [isDeciding, setIsDeciding] = React.useState(false);
  const [recordedAnswer, setRecordedAnswer] = React.useState<Readonly<{
    artifactId: string; decision: 'approve' | 'reject' | 'cancel';
  }> | null>(null);
  const recordedDecision = recordedAnswer?.artifactId === props.artifactId ? recordedAnswer.decision : null;
  const setRecordedDecision = React.useCallback((decision: 'approve' | 'reject' | 'cancel') => {
    setRecordedAnswer({ artifactId: props.artifactId, decision });
  }, [props.artifactId]);
  const decisionInFlightRef = React.useRef(false);

  const parsed = React.useMemo(() => {
    if (!artifact || typeof artifact.body !== 'string') return null;
    const matched = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body);
    if (matched?.family === 'execution_run_host_action') return { kind: 'host_action' as const, request: matched.request };
    if (matched?.family === 'target_action') return { kind: 'target' as const, request: matched.request };
    if (matched?.family === 'built_in') return { kind: 'built_in' as const, request: matched.request };
    return null;
  }, [artifact]);
  const builtInExecutionFailure = React.useMemo(() => (
    parsed?.kind === 'built_in' ? readApprovalExecutionFailure(parsed.request) : null
  ), [parsed]);
  const completionHandledRef = React.useRef(false);
  React.useEffect(() => {
    if (completionHandledRef.current || parsed?.request.status !== 'executed' || builtInExecutionFailure || !props.completionHref) return;
    completionHandledRef.current = true;
    if (props.completionFocusFrom && props.completionFocusTo) {
      retargetNavigationFocusReturn(props.completionFocusFrom, props.completionFocusTo);
    }
    router.dismissTo(props.completionHref);
  }, [parsed?.request.status, builtInExecutionFailure, props.completionFocusFrom, props.completionFocusTo, props.completionHref, retargetNavigationFocusReturn, router]);


  // One reading of the arguments decides both what the card shows and whether the
  // decision may be taken, so an invisible field can never sit behind a live
  // Approve button.
  const builtInApproveAdmission = React.useMemo(() => (
    parsed?.kind === 'built_in' && parsed.request.status === 'open'
      ? resolveApprovalRequestApproveAdmission(parsed.request)
      : null
  ), [parsed]);
  const actionFields = React.useMemo(() => builtInApproveAdmission?.presentation
    ?? (parsed?.kind === 'built_in' ? describeApprovalRequestFields(parsed.request) : null), [builtInApproveAdmission, parsed]);
  // A Project's setup or command reads as the machine and the exact command, not as its protocol operands.
  const projectCommand = React.useMemo(
    () => (parsed?.kind === 'built_in' ? readProjectCommandApproval(parsed.request) : null),
    [parsed],
  );
  const projectCommandTitle = useProjectCommandApprovalTitle(projectCommand);
  const projectCommandDecisions = projectCommand ? describeProjectCommandApprovalDecisions(projectCommand) : null;
  const approvalWithheld = builtInApproveAdmission?.status === 'unavailable';

  const request = parsed?.request ?? null;
  const confidentialAction = parsed?.kind === 'built_in' && isConfidentialSecretApprovalAction(parsed.request.actionId);
  const confidentialApproval = parsed?.kind === 'built_in' ? readConfidentialSecretApproval(parsed.request) : null;
  const confidentialReviewKey = confidentialApproval && parsed?.kind === 'built_in'
    ? JSON.stringify([parsed.request.actionId, parsed.request.actionArgs,
        parsed.request.v === 2 ? parsed.request.executionOriginV1 : null, parsed.request.createdBy])
    : null;
  const requesterSurface = parsed?.kind === 'built_in'
    ? parsed.request.v === 2
      ? parsed.request.executionOriginV1.surface
      : parsed.request.requestedSurface ?? ''
    : parsed?.request.createdBy.surface ?? '';
  const sessionId = parsed?.kind === 'built_in'
    ? parsed.request.v === 2
      ? parsed.request.executionOriginV1.sessionId ?? parsed.request.createdBy.sessionId ?? ''
      : parsed.request.createdBy.sessionId ?? ''
    : parsed?.kind === 'target'
      ? parsed.request.executionOriginV1?.sessionId
        ?? parsed.request.replayPlacement?.defaultSessionId
        ?? parsed.request.createdBy.sessionId
        ?? ''
      : parsed?.kind === 'host_action'
        ? parsed.request.sessionId
        : '';
  // Requested by already names the asking Session; a target that is that same Session keeps its
  // exact identity one disclosure away instead of repeating it as a second row.
  const shownActionFields = React.useMemo(() => actionFields && sessionId ? {
    ...actionFields,
    rows: actionFields.rows.map(row => row.kind === 'value' && row.reference?.kind === 'session'
      && row.reference.id === sessionId ? { ...row, technical: true as const } : row),
  } : actionFields, [actionFields, sessionId]);
  const builtInReplayRoute = React.useMemo(
    () => resolveApprovalReplayRoute(parsed?.kind === 'built_in' ? parsed.request : null),
    [parsed],
  );
  const approvalServerId = React.useMemo(() => {
    if (!parsed) return null;
    if (parsed.kind === 'built_in' && parsed.request.v === 2) {
      return (builtInReplayRoute?.serverId
        ?? requestedServerId
        ?? parsed.request.executionOriginV1.serverId.trim()) || null;
    }
    if (parsed.kind === 'target') {
      return parsed.request.executionOriginV1?.serverId
        ?? parsed.request.replayPlacement?.serverId
        ?? requestedServerId;
    }
    if (parsed.kind === 'host_action') return parsed.request.serverId;
    const requestServerId = parsed.kind === 'built_in'
      ? typeof (parsed.request as { serverId?: unknown }).serverId === 'string'
          ? String((parsed.request as { serverId?: string }).serverId).trim()
          : ''
      : '';
    if (requestServerId.length > 0) return requestServerId;
    if (requestedServerId) return requestedServerId;
    return sessionId ? resolvePreferredServerIdForSessionId(sessionId) ?? null : null;
  }, [builtInReplayRoute?.serverId, parsed, requestedServerId, sessionId]);
  const approvedWorkspaceSyncResolution = React.useMemo(() => {
    if (parsed?.kind !== 'built_in' || parsed.request.v !== 2
      || parsed.request.actionId !== 'workspace.sync.conflict.resolve') return null;
    const result = WorkspaceSyncConflictResolutionV1Schema.safeParse(parsed.request.actionArgs);
    return result.success ? result.data : null;
  }, [parsed]);
  const reportedWorkspaceSyncOutcome = React.useMemo(() => {
    if (!approvedWorkspaceSyncResolution || parsed?.kind !== 'built_in'
      || parsed.request.status !== 'executed' || !parsed.request.execution?.ok) return null;
    const result = WorkspaceSyncConflictResolutionResultV1Schema.safeParse(parsed.request.execution.result);
    return result.success ? result.data : null;
  }, [approvedWorkspaceSyncResolution, parsed]);
  const approvalOriginHomeId = parsed?.kind === 'built_in' && parsed.request.v === 2
    ? joinHappierFacts(
        parsed.request.executionOriginV1.serverIdentityId?.trim(),
        parsed.request.executionOriginV1.serverId.trim(),
      )
    : approvalServerId;
  const approvalRouteUnavailable = homeUnavailable || (parsed?.kind === 'built_in'
    && isApprovalReplayRouteUnavailable(parsed.request));
  // The Home is named as the person knows it. Its exact identity stays the fallback: when this
  // device has no profile for it, or the saved route no longer matches the Home that asked.
  const approvalHomeKnown = Boolean(approvalServerId && !approvalRouteUnavailable && getServerProfileById(approvalServerId));
  const approvalHomeName = approvalHomeKnown ? resolveApprovalHomeName(approvalServerId) : null;
  const decideBuiltInApproval = useApprovalDecisionHandler(
    { id: artifact?.id ?? props.artifactId, header: artifact?.header ?? null },
    parsed?.kind === 'built_in' ? parsed.request : null,
    sessionId,
    approvalServerId,
  );
  // An agent's cleanup or stop proposal reads as the same card body as in the transcript (AGW-6).
  const proposal = useResourceProposalCheck(parsed?.kind === 'built_in' ? parsed.request : null, approvalServerId, props.artifactId);
  const proposalLabels = proposal ? resolveResourceProposalLabels(proposal) : null;
  const session = useSessionListRenderableWithServerScope(
    approvalServerId,
    approvalServerId ? sessionId : '',
  );
  const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
  const machineId = readDisplayMachineIdForSession({
    sessionId: null,
    metadata: ownerMetadata,
  });
  const machine = useServerScopedMachine(approvalServerId, approvalServerId ? machineId : '');
  const { resolution: approvalScopeResolution, binding: approvalAccountLifetime } = useServerCredentialAccountScopeBinding(approvalServerId);
  const homeObservations = useSessionListHomeObservations();
  // Context currentness is source-owned. Its relative age subscribes only at the context-line leaf.
  const homeObservation = approvalServerId ? homeObservations[approvalServerId] : null;
  const contextServerProfile = approvalServerId ? getServerProfileById(approvalServerId) : null;
  const contextAudienceScope = approvalScopeResolution.kind === 'bound' ? approvalScopeResolution.scope : null;
  const sessionContextFacts = React.useMemo(() => approvalServerId && session
    ? buildSessionContextFacts({
        address: { serverId: approvalServerId, sessionId },
        serverProfile: contextServerProfile,
        awareness: projectUiSessionAwareness(session, Date.now()),
        viewer: session.viewer,
        audienceContext: session.access?.audienceContext,
        audienceScope: contextAudienceScope,
        homeDir: ownerMetadata?.homeDir ?? null,
        homeObservation: homeObservation ?? null,
      })
    : null, [approvalServerId, contextAudienceScope, contextServerProfile, homeObservation, ownerMetadata?.homeDir, session, sessionId]);
  const sessionContext = React.useMemo(() => sessionContextFacts ? projectSessionContextPresentation(sessionContextFacts) : null, [sessionContextFacts]);
  const computerChoice = useComputerApprovalChoice({
    artifactId: artifact?.id ?? props.artifactId,
    actionId: parsed?.kind === 'built_in' ? String(parsed.request.actionId) : '',
    actionArgs: parsed?.kind === 'built_in' ? parsed.request.actionArgs : null,
    approvedInput: parsed?.kind === 'built_in' && parsed.request.v === 2
      && parsed.request.status !== 'open' && parsed.request.decision?.kind === 'approve'
      ? parsed.request.decision.narrowedInput : undefined,
    preview: parsed?.kind === 'built_in' ? parsed.request.preview : null,
    sessionId,
    serverId: approvalServerId,
    accountLifetime: approvalAccountLifetime,
    resolveOpenPicker: resolveComputerPicker,
  });
  const computerAction = computerChoice.presentation;
  const chooseComputerTarget = computerChoice.chooseTarget;
  const computerCaptureMedia = computerAction?.captureMedia ?? null;
  const computerCropMedia = React.useMemo(() => (computerCaptureMedia ? [{
    id: computerCaptureMedia.mediaId,
    name: computerAction?.target?.title ?? '',
    path: computerCaptureMedia.file.path,
    mimeType: computerCaptureMedia.file.mimeType,
    sizeBytes: computerCaptureMedia.sizeBytes,
    sha256: computerCaptureMedia.file.sha256,
    width: computerCaptureMedia.width,
    height: computerCaptureMedia.height,
    category: 'tool-artifact' as const,
    role: 'output' as const,
  }] : []), [computerAction?.target?.title, computerCaptureMedia]);
  const handoffTargetApproval = parsed?.kind === 'built_in'
    ? parsed.request.handoffTargetReplacementApproval ?? null
    : null;
  const handoffTargetActionArgs = parsed?.kind === 'built_in' ? parsed.request.actionArgs : null;
  const handoffTargetServerId = handoffTargetApproval?.serverId ?? approvalServerId;
  const handoffTargetMachine = useServerScopedMachine(
    handoffTargetServerId,
    handoffTargetServerId ? handoffTargetApproval?.machineId ?? '' : '',
  );
  const handoffTargetPresentation = React.useMemo(() => (
    handoffTargetApproval
      ? describeHandoffTargetApproval({
        approval: handoffTargetApproval,
        actionArgs: handoffTargetActionArgs,
        source: sessionContext
          ? {
              machineLabel: readApprovalSessionEndpointLabels({ session, machine, machineId }).machineLabel,
              pathLabel: sessionContext.workspace?.label ?? null,
            }
          : readApprovalSessionEndpointLabels({ session, machine, machineId }),
        destination: readApprovalTargetEndpointLabels({
          machineId: handoffTargetApproval.machineId,
          machine: handoffTargetMachine,
          canonicalRoot: handoffTargetApproval.canonicalRoot,
        }),
      })
      : null
  ), [handoffTargetApproval, handoffTargetActionArgs, handoffTargetMachine, machine, machineId, session, sessionContext]);
  const decide = React.useCallback(
    async (decision: 'approve' | 'reject' | 'cancel', choice?: Readonly<{ keepUndo?: boolean }>) => {
      if (!parsed || decisionInFlightRef.current || parsed.request.status !== 'open') return;
      // Fails closed for a programmatic press too, not only for the dimmed control.
      if (decision === 'approve' && (approvalWithheld || confidentialAction || proposal?.approveWithheld)) return;

      try {
        decisionInFlightRef.current = true;
        setIsDeciding(true);
        if (parsed.kind === 'target') {
          if (parsed.request.replayPlacement !== undefined && decision !== 'cancel') {
            const replay = await replayApprovalRequestAtExactDaemon({
              artifactId: props.artifactId,
              decision,
              executionTarget: parsed.request.replayPlacement,
            });
            if (replay !== null
              && typeof replay === 'object'
              && 'ok' in replay
              && replay.ok === false) {
              const errorCode = 'errorCode' in replay && typeof replay.errorCode === 'string'
                ? replay.errorCode
                : 'approval_decision_failed';
              throw new HappyError(errorCode, false, { code: errorCode });
            }
            await refreshArtifact();
            return;
          }
          const now = Date.now();
          const nextRequest: TargetActionApprovalRequestV1 = decision === 'cancel'
            ? { ...parsed.request, status: 'canceled', updatedAtMs: now }
            : {
              ...parsed.request,
              status: decision === 'approve' ? 'approved' : 'rejected',
              updatedAtMs: now,
              decision: { kind: decision, decidedAtMs: now },
            };
          const validated = TargetActionApprovalRequestV1Schema.parse(nextRequest);
          const header = buildTargetActionApprovalArtifactHeaderV1(validated);
          if (requestedServerId) {
            const context = await captureActionAccountContext(requestedServerId);
            try { await context.updateArtifact(props.artifactId, header, JSON.stringify(validated)); }
            finally { context.dispose(); }
          } else { await sync.updateArtifactWithHeader(props.artifactId, header, JSON.stringify(validated)); }
        } else if (parsed.kind === 'host_action') {
          const now = Date.now();
          const nextRequest: ExecutionRunHostActionApprovalRequestV1 = decision === 'cancel'
            ? { ...parsed.request, status: 'canceled', updatedAtMs: now }
            : {
              ...parsed.request,
              status: decision === 'approve' ? 'approved' : 'rejected',
              updatedAtMs: now,
              decision: { kind: decision, decidedAtMs: now },
            };
          const validated = ExecutionRunHostActionApprovalRequestV1Schema.parse(nextRequest);
          const header = buildExecutionRunHostActionApprovalArtifactHeaderV1(validated);
          if (requestedServerId) {
            const context = await captureActionAccountContext(requestedServerId);
            try { await context.updateArtifact(props.artifactId, header, JSON.stringify(validated)); }
            finally { context.dispose(); }
          } else { await sync.updateArtifactWithHeader(props.artifactId, header, JSON.stringify(validated)); }
        } else {
          // An agent's window choice is approved with the exact window the person picked.
          if (decision === 'approve' && computerChoice.needsChoiceBeforeApprove) {
            computerChoice.chooseTarget();
            return;
          }
          const options = proposal && decision !== 'cancel' ? proposal.decisionOptions(decision, choice)
            : decision === 'approve' ? computerChoice.decisionOptions : undefined;
          if (!await decideBuiltInApproval(decision, options)) {
            throw new Error('approval_decision_failed');
          }
          // The decision owner accepted the answer. A request another device placed reads open
          // until its host replays the decision, so the page says the answer it recorded.
          setRecordedDecision(decision);
        }
        await refreshArtifact();
      } catch (err) {
        const isStaleDecision = isApprovalDecisionStale(err);
        const isVersionConflict = !isStaleDecision && err instanceof Error && err.message.includes('modified by another client');
        if (isVersionConflict || isStaleDecision) {
          try {
            await refreshArtifact();
          } catch {
            // The original decision failure remains authoritative and is still shown below.
          }
        }
        const message = isVersionConflict ? err.message : getApprovalDecisionErrorMessage(err);
        Modal.alert(t('common.error'), message);
      } finally {
        decisionInFlightRef.current = false;
        setIsDeciding(false);
      }
    },
    [approvalWithheld, confidentialAction, computerChoice, decideBuiltInApproval, parsed, proposal, props.artifactId, refreshArtifact, requestedServerId, sessionId, setRecordedDecision],
  );

  if (isLoading) {
    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <ActivitySpinner size="large" color={theme.colors.text.secondary} />
        </View>
      </View>
    );
  }

  if (artifact?.isDecrypted === false) {
    const lockedMessage = artifact.availability.reason === 'encryption_material_unavailable'
      ? t('settingsAccount.secretKeyMissing')
      : t('approvals.loadError');

    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <Text style={{ color: theme.colors.text.secondary }}>{lockedMessage}</Text>
          <View style={{ height: 12 }} />
          <RoundButton
            size="normal"
            display="secondary"
            title={t('common.back')}
            onPress={() => goBack()}
          />
        </View>
      </View>
    );
  }

  if (error || !parsed) {
    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <Text style={{ color: theme.colors.text.secondary }}>{error || t('approvals.loadError')}</Text>
          <View style={styles.recoveryActions}>
            {error ? (
              <RoundButton
                testID="approvals.retry"
                size="normal"
                title={t('common.retry')}
                accessibilityLabel={t('common.retry')}
                onPress={() => void refreshArtifact()}
              />
            ) : null}
            <RoundButton
              size="normal"
              display="secondary"
              title={t('common.back')}
              accessibilityLabel={t('common.back')}
              onPress={() => goBack()}
            />
          </View>
        </View>
      </View>
    );
  }

  // Only an open request shows a recorded answer; any later stored status is the newer fact.
  const answeredWhileOpen = parsed.request.status === 'open' ? recordedDecision : null;
  const statusLabel = formatApprovalStatusLabel(builtInExecutionFailure ? 'failed'
    : answeredWhileOpen === 'approve' ? 'approved'
      : answeredWhileOpen === 'reject' ? 'rejected'
        : answeredWhileOpen === 'cancel' ? 'canceled'
          : parsed.request.status);
  const targetActionParts = parsed.kind === 'target'
    ? parsed.request.qualifiedActionId.split('/actions/')
    : null;
  const executionFailureResult = builtInExecutionFailure ?? (parsed.kind === 'host_action'
    || parsed.request.status !== 'failed'
    || parsed.request.execution?.ok !== false
    ? null
    : { errorCode: parsed.request.execution.errorCode, error: parsed.request.execution.error });
  const executionFailure = executionFailureResult
    ? getApprovalDecisionErrorMessage(executionFailureResult,
        executionFailureResult.error || executionFailureResult.errorCode || t('approvals.decisionError'))
    : null;
  // Who is asking for what: the plugin and action of a target request, or the plugin and proposal
  // count of a host action. The action's name and exact identifiers are the Action row.
  const headerFacts: PageHeaderMetaFact[] = [];
  if (targetActionParts) {
    headerFacts.push({ key: 'target-source', text: targetActionParts[0] ?? '' });
    if (targetActionParts[1]) headerFacts.push({ key: 'target-action', text: targetActionParts[1] });
  }
  if (parsed.kind === 'host_action') {
    headerFacts.push({ key: 'plugin', text: parsed.request.pluginId });
    headerFacts.push({ key: 'proposals', text: t('approvals.proposedComments', { count: parsed.request.proposalCount }) });
  }
  // The one title rule shared with the Inbox row: no raw ids, a disclosure after the first line.
  const requestTitle = resolveApprovalRequestTitle({
    storedTitle: parsed.request.summary,
    actionId: parsed.kind === 'target' ? null : String(parsed.request.actionId),
    qualifiedActionId: parsed.kind === 'target' ? parsed.request.qualifiedActionId : null,
    ...(parsed.kind === 'built_in' ? { actionArgs: parsed.request.actionArgs, preview: parsed.request.preview } : {}),
    sessionIds: [sessionId, parsed.request.createdBy.sessionId],
  });
  const actionValue = requestTitle.actionTitle
    ?? (parsed.kind === 'target' ? parsed.request.qualifiedActionId : String(parsed.request.actionId));
  // A built-in Action is named by its title alone; its raw id is not copy. A plugin's host action
  // keeps the identifiers that say which plugin code will run.
  const actionIdentifiers = [
    parsed.kind === 'host_action' ? parsed.request.actionId : null,
    parsed.kind === 'target' ? parsed.request.sourceCustody.kind : null,
    parsed.kind === 'host_action' ? parsed.request.profileId : null,
  ].filter((value): value is string => Boolean(value));
  const previewSummary = parsed.kind === 'built_in' ? readApprovalPreviewSummary(parsed.request.preview, parsed.request) : null;
  // A Session visual is approved by looking at it, not by reading its arguments.
  const visualPreview = parsed.kind === 'built_in' ? resolveApprovalVisualPreview({
    actionId: String(parsed.request.actionId), actionArgs: parsed.request.actionArgs,
    ...(parsed.request.preview === undefined ? {} : { preview: parsed.request.preview }),
  }) : null;
  // The Action row names the Action only when the title has not already said it.
  const showActionRow = actionIdentifiers.length > 0 || actionValue !== requestTitle.title;

  return (
    <ItemList>
      <PageHeader
        testID="approvals.header"
        alwaysShowTitle
        title={projectCommandTitle ?? (requestTitle.title || t('approvals.untitled'))}
        description={parsed.kind === 'target' && parsed.request.detail
          ? parsed.request.detail
          : requestTitle.detail ?? undefined}
        meta={headerFacts.length > 0 ? headerFacts : undefined}
      />

      <ItemGroup
        title={t('detailPages.approval.requestTitle')}
        description={t('detailPages.approval.requestDescription')}
      >
        {parsed.kind === 'built_in' && previewSummary ? (
          <SectionContentRow testID="approvals.preview">
            <ApprovalPreviewCard preview={parsed.request.preview} request={parsed.request} />
          </SectionContentRow>
        ) : null}
        {/* The summary says what will appear and where; the visual follows it. */}
        {visualPreview ? (
          <ApprovalVisualPreview preview={visualPreview} artifactId={props.artifactId}
            serverId={approvalServerId ?? null} testID="approvals.visual" />
        ) : null}
        {showActionRow ? (
          <Item
            testID="approvals.action"
            title={t('approvals.fieldAction')}
            subtitle={joinHappierFacts(actionValue, ...actionIdentifiers)}
            subtitleLines={0}
            mode="info"
            showChevron={false}
          />
        ) : null}
        <Item
          testID="approvals.status"
          title={t('approvals.fieldStatus')}
          detail={statusLabel}
          mode="info"
          showChevron={false}
        />
        {executionFailure ? (
          <Item
            testID="approvals.execution-failure"
            title={t('detailPages.approval.failureTitle')}
            subtitle={executionFailure}
            subtitleLines={0}
            mode="info"
            showChevron={false}
          />
        ) : null}
        {approvalRouteUnavailable ? (
          <Item
            testID="approvals.home-unavailable"
            title={t('detailPages.approval.homeUnavailableTitle')}
            subtitle={t('actionConfirmations.homeUnavailable')}
            subtitleLines={0}
            mode="info"
            showChevron={false}
          />
        ) : null}
      </ItemGroup>

      {computerAction ? (
        <ItemGroup title={t('computerUse.approval.sectionTitle')}>
          <SectionContentRow>
            <ComputerActionApprovalCard
              presentation={computerAction}
              onChooseTarget={chooseComputerTarget}
              media={computerCaptureMedia ? (
                <SessionStoredImageThumbnail
                  sessionId={computerCaptureMedia.file.sessionId}
                  serverId={approvalServerId}
                  machineId={computerAction.machineId}
                  storage={computerCaptureMedia.file.storage}
                  media={computerCropMedia}
                  mediaPreviewEnabled
                  testID="approvals.computer-action-crop"
                />
              ) : undefined}
            />
          </SectionContentRow>
        </ItemGroup>
      ) : null}

      {handoffTargetPresentation ? (
        <ItemGroup title={t('sessionHandoff.targetApproval.title')}>
          <SectionContentRow>
            <HandoffTargetConsequencesCard presentation={handoffTargetPresentation} />
          </SectionContentRow>
        </ItemGroup>
      ) : null}

      {proposal && proposalLabels ? (
        <ItemGroup title={proposalLabels.title}>
          <ResourceProposalBody controller={proposal} decisionsAvailable={!approvalRouteUnavailable}
            arrive={false} onApproveKeepingUndo={() => { void decide('approve', { keepUndo: true }); }}
            testID="approvals.resource-proposal" />
        </ItemGroup>
      ) : projectCommand ? (
        <ItemGroup title={t('approvals.details')}>
          <SectionContentRow>
            <ProjectCommandApprovalFacts presentation={projectCommand} testID="approvals.project-command" />
          </SectionContentRow>
        </ItemGroup>
      ) : shownActionFields && !confidentialAction ? (
        <ActionApprovalFieldsCard presentation={shownActionFields} anatomy="page" serverId={approvalServerId} />
      ) : null}

      {approvedWorkspaceSyncResolution ? (
        <ItemGroup surface="none">
          <View testID="workspace-sync-approved-review">
            <WorkspaceSyncConflictDetailsView
              embedded
              approvedRequest={approvedWorkspaceSyncResolution}
              reportedOutcome={reportedWorkspaceSyncOutcome ?? undefined}
              resource={{ kind: 'workspaceSyncConflicts',
                hubWorkspaceRefId: approvedWorkspaceSyncResolution.hubWorkspaceRefId,
                workspaceRefId: approvedWorkspaceSyncResolution.source.workspaceRefId,
                controllerMachineId: approvedWorkspaceSyncResolution.controllerMachineId,
                serverId: approvalServerId,
                initialPath: approvedWorkspaceSyncResolution.path }}
            />
          </View>
        </ItemGroup>
      ) : null}

      {/* Who asked follows what they asked for: the thing being decided leads the page. */}
      <ApprovalSessionContextCard
        session={session}
        machine={machine}
        serverId={approvalServerId}
        context={sessionContext}
        contextFacts={sessionContextFacts}
        homeName={approvalHomeName}
        // A Home this device knows but that has no name is "This Home", never its address; only a
        // Home it does not know (or can no longer route to) shows its exact identity.
        homeDisplayId={approvalHomeKnown ? t('settingsAccount.thisHomeTitle') : approvalOriginHomeId}
        requesterSessionId={sessionId}
        requesterAgentId={parsed.request.createdBy.agentId ?? null}
        requesterSurface={requesterSurface}
      />

      {parsed.kind === 'host_action' && parsed.request.proposalPreview.length > 0 ? (
        <ItemGroup
          title={t('approvals.proposedComments', { count: parsed.request.proposalCount })}
          description={t('detailPages.approval.proposalsDescription')}
        >
          {parsed.request.proposalPreview.map((proposal, index) => (
            <Item
              key={`${proposal.pathSha256}:${proposal.bodySha256}:${index}`}
              title={`${proposal.pathLabel}${proposal.startLine ? `:${proposal.startLine}` : ''}`}
              subtitle={proposal.bodyPreview}
              subtitleLines={0}
              detail={proposal.severity ?? undefined}
              mode="info"
              showChevron={false}
            />
          ))}
        </ItemGroup>
      ) : null}

      {confidentialApproval ? <ConfidentialSecretApproval key={confidentialReviewKey} artifactId={props.artifactId}
        approval={confidentialApproval} serverId={approvalServerId} isOpen={parsed.request.status === 'open' && !answeredWhileOpen}
        unavailable={approvalRouteUnavailable} isDeciding={isDeciding} onDecision={decide} /> : null}

      {parsed.request.status === 'open' && !answeredWhileOpen && !confidentialApproval ? (
        <ItemGroup surface="none">
          {/* Dismiss closes without an answer; Reject answers no. Consent remains with decide. */}
          <ApprovalDecisionBar testID="approvals.actions" busy={isDeciding && !homeUnavailable}
            layout={handoffTargetPresentation ? 'stacked' : 'inline'}
            approve={!confidentialAction ? {
              testID: 'approvals.approve', label: handoffTargetPresentation?.decisionLabel ?? projectCommandDecisions?.approve ?? proposalLabels?.approve,
              disabled: isDeciding || approvalWithheld || approvalRouteUnavailable || Boolean(proposal?.approveWithheld),
              accessibilityHint: approvalRouteUnavailable ? t('actionConfirmations.homeUnavailable')
                : approvalWithheld ? t('approvals.approveUnavailableHint') : undefined,
              onPress: () => decide('approve'),
            } : undefined}
            dismiss={projectCommand ? undefined : { testID: 'approvals.cancel', disabled: isDeciding, accessibilityHint: t('approvals.dismissHint'),
              onPress: () => decide('cancel') }}
            reject={{ testID: 'approvals.reject', label: projectCommandDecisions?.reject ?? proposalLabels?.reject, disabled: isDeciding || approvalRouteUnavailable,
              accessibilityHint: approvalRouteUnavailable ? t('actionConfirmations.homeUnavailable') : undefined,
              onPress: () => decide('reject') }} />
        </ItemGroup>
      ) : null}
    </ItemList>
  );
});

ApprovalDetailScreen.displayName = 'ApprovalDetailScreen';
