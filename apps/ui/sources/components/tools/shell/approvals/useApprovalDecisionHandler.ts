import * as React from 'react';

import type { ActionId, ApprovalRequest } from '@happier-dev/protocol';
import { ApprovalExecutionV1Schema, type ApprovalExecutionV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { TeamInvitationCreateResultV1Schema, TeamInvitationReissueResultV1Schema } from '@happier-dev/protocol/teams';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import {
    createDefaultActionExecutor,
    requiresExactDaemonApprovalReplay,
    resolveApprovalReplayRoute,
    type ApprovalReplayRoute,
} from '@/sync/ops/actions/defaultActionExecutor';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createApiTokenSettingsController } from '@/components/settings/apiTokens/apiTokenSettingsController';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { showApiTokenCreateModal } from '@/components/settings/apiTokens/showApiTokenCreateModal';
import { TeamLinkDelivery } from '@/components/settings/teams/TeamLinkDelivery';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors/errors';
import { recordResourceProposalDeclines } from '@/components/approvals/resourceProposal/recordResourceProposalDeclines';
import { t } from '@/text';
import { ProviderErrorCodeV1Schema } from '@happier-dev/protocol/providers/errors';
import { presentProviderError } from '@/providers/connection/errorPresentation';

export { resolveApprovalReplayRoute };

/** Live errors and durable execution failures retain the same typed outcome. */
export function isApprovalDecisionStale(error: unknown): boolean {
    return error instanceof HappyError ? error.code === 'approval_stale'
        : typeof error === 'object' && error !== null && 'errorCode' in error && error.errorCode === 'approval_stale';
}

/** Shared recovery copy for the detail page and transcript approval card. */
export function getApprovalDecisionErrorMessage(error: unknown, fallbackMessage = t('approvals.decisionError')): string {
    if (isApprovalDecisionStale(error)) return t('approvals.staleFailure');
    const code = typeof error === 'object' && error !== null
        ? 'errorCode' in error ? error.errorCode : 'code' in error ? error.code : null
        : error;
    const providerCode = ProviderErrorCodeV1Schema.safeParse(code);
    if (providerCode.success && providerCode.data.startsWith('provider_')) {
        return t(presentProviderError(providerCode.data).descriptionKey);
    }
    if (error instanceof HappyError && error.code === 'present_user_required') {
        return t('approvals.decisionAuthorityError');
    }
    // Retain the typed code, never opaque transport prose or private details.
    return typeof code === 'string' && /^[a-z][a-z0-9_]*$/.test(code)
        ? fallbackMessage === code ? code : `${fallbackMessage} (${code})` : fallbackMessage;
}

type ApprovalDecisionArtifact = Pick<DecryptedArtifact, 'id' | 'header'>;

function requiresResolvedReplayRoute(approval: ApprovalRequest): boolean {
    return approval.v === 2 && (
        requiresExactDaemonApprovalReplay(approval)
        || Boolean(approval.executionOriginV1.serverIdentityId?.trim())
    );
}

export function isApprovalReplayRouteUnavailable(approval: ApprovalRequest | null): boolean {
    return Boolean(approval && requiresResolvedReplayRoute(approval) && !resolveApprovalReplayRoute(approval));
}

function readServerId(
    artifact: ApprovalDecisionArtifact,
    approval: ApprovalRequest | null,
    replayRoute: ApprovalReplayRoute | null,
    sessionId: string,
    serverIdHint?: string | null,
): string | null {
    if (approval?.v === 2 && replayRoute) return replayRoute.serverId;
    // The mounted Artifact Home remains usable for cancellation even when its
    // execution origin cannot be reached. Approve/reject require replayRoute below.
    const normalizedServerIdHint = serverIdHint?.trim() ?? '';
    if (normalizedServerIdHint.length > 0) return normalizedServerIdHint;
    const headerServerId = typeof artifact.header?.serverId === 'string' ? artifact.header.serverId.trim() : '';
    if (headerServerId.length > 0) return headerServerId;
    if (approval?.v === 2) return approval.executionOriginV1.serverId.trim() || null;
    return resolvePreferredServerIdForSessionId(sessionId) ?? null;
}

export type ApprovalDecisionOptions = Readonly<{
    /** The canonical execution receipt, distinct from recording the decision. */
    onExecution?: (execution: ApprovalExecutionV1 | null) => void;
    /** The deciding person's reduced operands, admitted by the requested Action. */
    narrowedInput?: unknown;
    /** A resource proposal's turned-down items, as the person last saw them (plan 60 AGW-8). */
    declinedItems?: readonly Readonly<Record<string, unknown>>[];
}>;

/** Presentation and decisions use the same proven Home, including portable replay origins. */
export function useApprovalHome(
    artifact: ApprovalDecisionArtifact,
    approval: ApprovalRequest | null,
    sessionId: string,
    serverIdHint?: string | null,
): Readonly<{ serverId: string | null; replayRoute: ApprovalReplayRoute | null }> {
    const serverProfilesGeneration = useServerProfilesGeneration();
    const replayRoute = React.useMemo(
        () => resolveApprovalReplayRoute(approval),
        [approval, serverProfilesGeneration],
    );
    const serverId = React.useMemo(
        () => readServerId(artifact, approval, replayRoute, sessionId, serverIdHint),
        [approval, artifact, replayRoute, serverIdHint, sessionId],
    );
    return { serverId, replayRoute };
}

export function useApprovalDecisionHandler(
    artifact: ApprovalDecisionArtifact,
    approval: ApprovalRequest | null,
    sessionId: string,
    serverIdHint?: string | null,
): (decision: 'approve' | 'reject' | 'cancel', options?: ApprovalDecisionOptions) => Promise<boolean> {
    const { serverId, replayRoute } = useApprovalHome(artifact, approval, sessionId, serverIdHint);
    const executor = React.useMemo(
        () => createDefaultActionExecutor({
            resolveServerIdForSessionId: (targetSessionId) => resolvePreferredServerIdForSessionId(targetSessionId) ?? null,
        }),
        [],
    );
    const mounted = React.useRef(true);
    const publicPreparation = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; publicPreparation.current?.abort(); };
    }, [artifact.id, approval, serverId]);
    return React.useCallback(async (decision: 'approve' | 'reject' | 'cancel', options?: ApprovalDecisionOptions) => {
        if (!approval) return false;
        // Portable or daemon-owned origins must resolve their immutable Home identity. A
        // present-user UI approval intentionally has no cryptographic Home identity and stays
        // on its exact mounted route instead of being misclassified as cross-device replay.
        if (decision !== 'cancel' && requiresResolvedReplayRoute(approval) && !replayRoute) {
            throw new HappyError('approval_origin_unavailable', false, { code: 'approval_origin_unavailable' });
        }
        if (
            decision === 'approve'
            && requiresExactDaemonApprovalReplay(approval)
            && (approval.v !== 2 || !approval.executionOriginV1.machineId?.trim())
        ) throw new HappyError('approval_origin_unavailable', false, { code: 'approval_origin_unavailable' });
        const revealsCreatedToken = decision === 'approve' && approval.actionId === 'account.apiTokens.create';
        const revealsInvitation = decision === 'approve'
            && (approval.actionId === 'teams.invitations.create' || approval.actionId === 'teams.invitations.reissue');
        const revealsLiveResult = revealsCreatedToken || revealsInvitation;
        const publicLinkActionId = approval.actionId === 'session.public_link.create' || approval.actionId === 'artifact.public_link.create'
            ? approval.actionId : null;
        const publicLink = decision === 'approve' && publicLinkActionId !== null;
        const preparation = publicLink ? new AbortController() : null;
        if (preparation) publicPreparation.current = preparation;
        let publicLinkConfirmed = false;
        let narrowedInput = options?.narrowedInput;
        let account: LazyActionAccountContext | null = null;
        let retainedForReveal = false;
        try {
            if (revealsLiveResult || publicLink) {
                if (!serverId) return false;
                account = await captureLazyActionAccountContext(serverId);
                if (account.credentialAuthorityKind !== 'account') return false;
                account.assertCurrent();
            }
            if (publicLink && account && preparation) {
                const { preparePublicLinkApproval } = await import('@/components/sharing/publicLinkApprovalPreparation');
                if (preparation.signal.aborted || !mounted.current) return true;
                const captured = account;
                const prepared = await preparePublicLinkApproval({ approval, account: captured, executor, signal: preparation.signal,
                    isCurrent: () => mounted.current && !preparation.signal.aborted && captured.accountLifetime.isCurrent() });
                if (publicPreparation.current === preparation) publicPreparation.current = null;
                if (prepared.kind === 'handled') return true;
                narrowedInput = prepared.narrowedInput;
                publicLinkConfirmed = true;
            }
            const result = await executor.execute(
                'approval.request.decide' as ActionId,
                {
                    artifactId: artifact.id,
                    decision,
                    ...(decision === 'approve' && narrowedInput !== undefined ? { narrowedInput } : {}),
                },
                { surface: 'ui',
                    ...(decision === 'approve' && narrowedInput !== undefined ? { authority: 'present_user' as const } : {}),
                    ...(serverId ? { serverId } : {}),
                    ...(publicLinkConfirmed && publicLinkActionId ? { presentUserConfirmation: { actionId: publicLinkActionId } } : {}),
                    ...(account ? { expectedAccountId: account.accountId } : {}) },
            );
            if (!result.ok) throw new HappyError(result.error, false, { code: result.errorCode });
            // A decision can be recorded successfully while its execution was refused.
            // Never let a stale receipt become an optimistic "Approved" answer.
            const outcome = result.result;
            const execution = typeof outcome === 'object' && outcome !== null && 'execution' in outcome
                ? ApprovalExecutionV1Schema.safeParse(outcome.execution) : null;
            if (execution?.success && execution.data.ok === false && isApprovalDecisionStale(execution.data)) {
                throw new HappyError(execution.data.error ?? 'approval_stale', false, { code: 'approval_stale' });
            }
            options?.onExecution?.(execution?.success ? execution.data : null);
            // A storage proposal remembers what the person turned down; best effort, the decision stands.
            void recordResourceProposalDeclines(approval, decision, narrowedInput, options?.declinedItems, serverId);
            if (!revealsLiveResult || !account) return true;
            account.assertCurrent();
            const live = typeof outcome === 'object' && outcome !== null && 'liveExecution' in outcome
                ? outcome.liveExecution : null;
            if (typeof live !== 'object' || live === null || !('ok' in live) || live.ok !== true
                || !('result' in live)) return false;
            const captured = account;
            if (revealsInvitation) {
                const parsed = approval.actionId === 'teams.invitations.create'
                    ? TeamInvitationCreateResultV1Schema.safeParse(live.result)
                    : TeamInvitationReissueResultV1Schema.safeParse(live.result);
                if (!parsed.success) return false;
                // Email delivery and replay legitimately have no human bearer to reveal.
                if (parsed.data.joinUrl === null) return true;
                const props = {
                    url: parsed.data.joinUrl,
                    testIDPrefix: 'team-invite-approval',
                    title: t('teams.invitations.linkRow'),
                    copyLabel: t('teams.invitations.copyLink'),
                    shareLabel: t('teams.invitations.shareLink'),
                    qrAccessibilityLabel: t('teams.invitations.qrLabel'),
                };
                let retirement: Readonly<{ dispose: () => void }> | undefined;
                const modalId = Modal.show({
                    component: TeamLinkDelivery,
                    props,
                    chrome: { kind: 'card', header: 'none', title: props.title, phonePresentation: 'sheet' },
                    onHostUnmount: () => {
                        retirement?.dispose();
                        captured.dispose();
                    },
                });
                retirement = captured.accountLifetime.onRetire(() => {
                    Modal.update(modalId, { ...props, url: '' });
                    Modal.hide(modalId);
                });
                retainedForReveal = true;
                return true;
            }
            const tokenId = typeof approval.actionArgs === 'object' && approval.actionArgs !== null
                && 'tokenId' in approval.actionArgs && typeof approval.actionArgs.tokenId === 'string'
                ? approval.actionArgs.tokenId : null;
            if (!tokenId) return false;
            const capturedContext = (context: Parameters<typeof executor.execute>[2]) => ({
                ...context, serverId: captured.serverId, expectedAccountId: captured.accountId,
            });
            const controller = createApiTokenSettingsController({
                captureActiveAccountScopeLifetime: () => captured.accountLifetime,
                execute: createFrontDoorActionExecute({
                    execute: (actionId, input, context) => executor.execute(actionId, input, capturedContext(context)),
                    prepare: (actionId, input, context) => executor.prepare(actionId, input, capturedContext(context)),
                }),
                now: () => Date.now(),
            });
            if (!controller.adoptCreatedToken({ result: live.result, tokenId, target: captured.accountLifetime })) {
                controller.retire();
                return false;
            }
            showApiTokenCreateModal(controller, undefined, () => {
                controller.retire();
                captured.dispose();
            });
            retainedForReveal = true;
            return true;
        } catch (error) {
            if (publicLink && preparation?.signal.aborted) return true;
            if (revealsLiveResult && account && !account.accountLifetime.isCurrent()) return false;
            throw error;
        } finally {
            if (publicPreparation.current === preparation) publicPreparation.current = null;
            if (!retainedForReveal) account?.dispose();
        }
    }, [approval, artifact.id, executor, replayRoute, serverId]);
}
