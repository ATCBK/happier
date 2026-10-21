import { isApiTokenGrantRestrictedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { SessionFollowPersonalProgressRequestV1Schema, type SessionFollowPersonalProgressRequestV1,
    type SessionFollowPersonalProgressResponseV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';

import { inTx, TransactionReplayRequiredError } from '@/storage/inTx';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { resolveEffectiveSessionAccess } from '@/app/session/access/sessionAccess';
import { readCurrentCommittedSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';
import { createSessionPersonalProjectionSelect, projectSessionViewer } from '@/app/session/personal/projection';
import { QUIET_SESSION_PERSONAL_DISCUSSION_FACTS } from '@/app/session/personal/discussionFacts';
import { resolveVisibleSessionSeq } from '@/app/session/personal/readState';
import { readSessionFollowOriginalOccurrenceFrontiersInTx, readSessionFollowRuleProgressInTx,
    writeSessionFollowRuleProgressInTx, type AccountFollowRuleProgressAdmission } from './sessionFollowRuleProgress';
import { isDeliveryMutedInTx } from './sessionDeliveryMuteService';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { readRunFollowOccurrenceInTx } from './sessionFollowEdgeService';
import { readAccountRunFollowDeliveryInTx } from './accountFollowService';
import type { ExecutionRunFollowFrontierWitness } from './executionRunFollowSource';
import { markSessionFollowsChangedInTx } from './changes';
import { observeAccountDiscussionFollowOccurrenceInTx } from './discussionFollowSource';
import { sourceKeyForSessionFollowSourceV1 } from './sessionFollowSourceIdentity';
import { acquireSessionAccountCursorLocksInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';

type ProgressFailure = 'invalid_parameters' | 'credential_scope_denied' | 'account_inactive';
type ProgressResult = Readonly<{ ok: true; value: SessionFollowPersonalProgressResponseV1 }>
    | Readonly<{ ok: false; error: ProgressFailure }>;
const unrepresented = { ok: true, value: { accepted: false, alreadyRepresented: false } } as const;

/**
 * Settles only current original effects already represented by the source
 * owner's private Inbox projection. Rule sources[] remains the sole rule
 * consumption owner; notification channel success is deliberately irrelevant.
 * The full-Account source executor opens encrypted request identities. The
 * Home binds that trusted full-map witness to the current state version; its
 * aggregate request counters include other sources and cannot prove this map.
 */
export async function acceptAccountFollowPersonalProgress(input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication; occurrence: SessionFollowPersonalProgressRequestV1;
    executionRunFrontier?: ExecutionRunFollowFrontierWitness;
}>): Promise<ProgressResult> {
    const parsed = SessionFollowPersonalProgressRequestV1Schema.safeParse(input.occurrence);
    if (!parsed.success) return { ok: false, error: 'invalid_parameters' };
    if (input.authentication.sessionRuntimePrincipal || input.authentication.apiTokenGrant
        && isApiTokenGrantRestrictedV1(input.authentication.apiTokenGrant)) return { ok: false, error: 'credential_scope_denied' };
    const occurrence = parsed.data;
    return inTx(async tx => {
        if (!('discussion' in occurrence) && !('original' in occurrence)) {
            // Personal rule progress publishes this Session. Admit its full
            // audience and parent resource before actor admission or KV writes.
            await acquireSessionAccountCursorLocksInTx(tx, [occurrence.sourceSessionId], [input.accountId]);
        }
        const account = await tx.account.findUnique({ where: { id: input.accountId }, select: { status: true } });
        if (account?.status !== 'active') return { ok: false, error: 'account_inactive' };
        if ((await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId, "content")).status !== 'ready') return unrepresented;
        if ('discussion' in occurrence) {
            const ref = occurrence.discussion.original;
            const current = await observeAccountDiscussionFollowOccurrenceInTx(tx, { ...input,
                request: { v: 1, source: { kind: 'discussion', discussionId: ref.discussion.discussionId }, messageId: ref.messageId } });
            if (!current || current.seq !== occurrence.discussion.seq) return unrepresented;
            if (current.personal.alreadyRepresented) return { ok: true, value: { accepted: true, alreadyRepresented: true } };
            const updated = await tx.accountSessionFollow.updateMany({ where: { accountId: input.accountId,
                sourceKey: sourceKeyForSessionFollowSourceV1(current.source), following: true,
                deliveredDiscussionSeq: { lt: current.seq } }, data: { deliveredDiscussionSeq: current.seq } });
            if (updated.count !== 1) throw new TransactionReplayRequiredError('follow-rule-progress-conflict');
            await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
            return { ok: true, value: { accepted: true, alreadyRepresented: false } };
        }
        if ('original' in occurrence) {
            if ('permissionRequests' in occurrence.original) return unrepresented;
            const current = await readRunFollowOccurrenceInTx(tx, { source: occurrence.original.source, original: occurrence.original,
                executionRunFrontier: input.executionRunFrontier });
            if (!current) return unrepresented;
            const follow = await readAccountRunFollowDeliveryInTx(tx, { ...input, ...current });
            if (!follow) return unrepresented;
            if (follow.represented) return { ok: true, value: { accepted: true, alreadyRepresented: true } };
            const updated = await tx.accountSessionFollow.updateMany({ where: { accountId: input.accountId, sourceKey: follow.sourceKey,
                following: true, ...('terminalEventId' in occurrence.original
                    ? { deliveredExecutionRunTerminalEventId: follow.deliveredExecutionRunTerminalEventId }
                    : { deliveredWorkflowRunRevision: follow.deliveredWorkflowRunRevision }) },
                data: 'terminalEventId' in occurrence.original ? { deliveredExecutionRunTerminalEventId: occurrence.original.terminalEventId }
                    : { deliveredWorkflowRunRevision: occurrence.original.revision } });
            if (updated.count !== 1) throw new TransactionReplayRequiredError('follow-rule-progress-conflict');
            await markSessionFollowsChangedInTx(tx, { accountId: input.accountId });
            return { ok: true, value: { accepted: true, alreadyRepresented: false } };
        }
        const source = await tx.session.findUnique({ where: { id: occurrence.sourceSessionId }, select: {
            ...createSessionPersonalProjectionSelect(input.accountId), agentStateVersion: true, publisherGeneration: true,
            encryptionMode: true,
        } });
        if (!source || source.accountId !== input.accountId || source.archivedAt !== null
            || source.publisherGeneration.toString() !== occurrence.expectedSourcePublisherGeneration) return unrepresented;
        const target = await readCurrentCommittedSessionInputMachineTargetInTx(tx, occurrence.sourceSessionId);
        if (target?.accountId !== input.accountId || target.machineId !== occurrence.machineId
            || target.installationId !== occurrence.installationId) return unrepresented;
        const access = await resolveEffectiveSessionAccess(tx, { accountId: input.accountId, sessionId: source.id,
            authentication: input.authentication });
        if (access?.capabilities.readTranscript !== true) return unrepresented;
        const muted = await isDeliveryMutedInTx(tx, { accountId: input.accountId, receiver: { kind: 'account' },
            candidate: { senderSessionId: source.id, source: { kind: 'session', sessionId: source.id } } });
        if (muted !== false) return unrepresented;
        const original = await readSessionFollowOriginalOccurrenceFrontiersInTx(tx, {
            source, occurrence, delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1,
        });
        // Self-authored personal sources are deliberately unselected, like a
        // source/rule mute: neither positive Inbox acceptance nor rule progress.
        if (!original || original.originalAuthorAccountId === input.accountId) return unrepresented;
        const viewer = projectSessionViewer({ row: source, viewerAccountId: input.accountId,
            discussion: QUIET_SESSION_PERSONAL_DISCUSSION_FACTS, effectiveAccess: access });
        if (!viewer.follow.follows && viewer.follow.notificationLevel === 'none') return unrepresented;
        if (occurrence.sourceMessage) {
            if (!viewer.attention.reasons.includes('unread') || viewer.readState.state !== 'tracking'
                || viewer.readState.lastViewedSessionSeq >= occurrence.sourceMessage.seq
                || occurrence.sourceMessage.seq > resolveVisibleSessionSeq(source)) return unrepresented;
        } else {
            if (!occurrence.sourceRequests
                || !viewer.attention.reasons.some(reason => reason === 'permission_required' || reason === 'user_action_required'
                    || reason === 'pending_blocked')) return unrepresented;
        }
        const progresses: AccountFollowRuleProgressAdmission[] = [];
        for (const rule of occurrence.rules) {
            const progress = await readSessionFollowRuleProgressInTx(tx, { accountId: input.accountId,
                sourceSessionId: source.id, rule });
            if (!progress || !progress.envelope.inception
                || await isDeliveryMutedInTx(tx, { accountId: input.accountId, receiver: { kind: 'account' },
                    candidate: { senderSessionId: source.id, source: { kind: 'rule', ruleId: rule.ruleId } } }) !== false) return unrepresented;
            const inception = progress.envelope.inception.createdAt;
            if (occurrence.sourceMessage ? original.originalCreatedAt < inception
                : !('requestIds' in rule) || rule.requestIds.some(requestId => {
                    const request = occurrence.sourceRequests?.requests.find(item => item.requestId === requestId);
                    return !request || request.createdAt < inception;
                })) return unrepresented;
            progresses.push(progress);
        }
        const alreadyRepresented = progresses.some(progress => occurrence.sourceMessage
            ? progress.delivered.transcriptSeq >= occurrence.sourceMessage.seq
            : progress.delivered.agentStateVersion >= occurrence.sourceRequests!.agentStateVersion);
        for (const progress of progresses) {
            const delivered = { ...progress.delivered,
                transcriptSeq: Math.max(progress.delivered.transcriptSeq, original.observed.transcriptSeq),
                agentStateVersion: Math.max(progress.delivered.agentStateVersion, original.observed.agentStateVersion) };
            if (!await writeSessionFollowRuleProgressInTx(tx, progress, delivered)) throw new TransactionReplayRequiredError('follow-rule-progress-conflict');
        }
        return { ok: true, value: { accepted: true, alreadyRepresented } };
    }, { isolationLevel: 'Serializable' });
}
