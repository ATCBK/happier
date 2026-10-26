import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { projectWorkflowDiscussionProducerV1, projectWorkflowDiscussionResultContentV1 } from '@happier-dev/protocol/workflows/workflowDiscussionPublicationV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

/**
 * An open `discussion.reply` approval an external plugin Action result raised for a Workflow Run,
 * built through the real approval producer schemas and header (not a hand-shaped approval record).
 */
export function createWorkflowPublicationApprovalArtifact(input: Readonly<{
    id: string;
    runId: string;
    scope: Readonly<{ serverId: string; accountId: string }>;
    requestKind?: 'publication' | 'invitation' | 'external';
}>): Extract<DecryptedArtifact, { isDecrypted: true }> & Readonly<{ body: string }> {
    const { id, runId, scope } = input;
    const result = { runId, invocationRecordId: 'invocation', invocationAttempt: '0', blockKind: 'action',
        lifecycle: 'completed', result: 'Result', execution: { kind: 'action', actionId: 'plugin:external/check' } };
    const producer = projectWorkflowDiscussionProducerV1(result);
    if (!producer) throw new Error('Expected a publishable external Action result');
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'agent' }, actionId: 'discussion.reply', summary: 'Review result',
        actionArgs: { discussionId: 'discussion', replyTarget: { kind: 'message', messageId: 'question' },
            content: projectWorkflowDiscussionResultContentV1(result) },
        executionOriginV1: { v: 1, serverId: scope.serverId, serverIdentityId: scope.serverId,
            accountId: scope.accountId, machineId: 'machine', actionId: 'discussion.reply', requestId: id,
            authority: 'account_automation', surface: 'agent',
            caller: { kind: 'workflowRun', runId, authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } },
            discussionReplyReturn: { kind: 'workflow_invocation', serverId: scope.serverId,
                producer,
                origin: { discussion: { serverId: scope.serverId, discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 } },
        } });
    const admitted = input.requestKind === 'invitation' ? ApprovalRequestV2Schema.parse({ ...request,
        actionId: 'discussion.invite', summary: 'Invite',
        actionArgs: { discussionId: 'discussion', participant: { kind: 'session', sessionId: 'invited-session' } },
        executionOriginV1: { ...request.executionOriginV1, actionId: 'discussion.invite', discussionReplyReturn: undefined },
    }) : request;
    const external = input.requestKind === 'external' ? TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify({
        v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'system' }, requestedSurface: 'agent', summary: 'Publish',
        qualifiedActionId: 'external.check/actions/check', input: {},
        sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-1', installSource: 'npm' },
        policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64),
        executionOriginV1: { ...request.executionOriginV1, actionId: 'action.invoke', discussionReplyReturn: undefined },
    }))) : null;
    const header = external ? buildTargetActionApprovalArtifactHeaderV1(external) : buildApprovalRequestArtifactHeaderV1(admitted);
    return { id, header, title: header.title ?? null, body: JSON.stringify(external ?? admitted),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true };
}
