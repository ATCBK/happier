import type { FollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { resolveDiscussionContextInTx } from '@/app/discussions/access';
import { resolveWorkflowRunAccessInTx } from '@/app/workflows/workflowRunAccess';
import { resolveEffectiveSessionAccess } from '@/app/session/access/sessionAccess';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { Tx } from '@/storage/inTx';

type FollowContentSource = Exclude<FollowSourceRefV1, { kind: 'rule' }>;

/** A Follow ref is readable only through its current source owner. */
export async function canReadFollowSourceInTx(tx: Tx, input: Readonly<{
    accountId: string; source: FollowContentSource; authentication: SessionAccessAuthentication;
}>): Promise<boolean> {
    const source = input.source;
    if (source.kind === 'session' || source.kind === 'execution_run') {
        return (await resolveEffectiveSessionAccess(tx, { accountId: input.accountId,
            sessionId: source.sessionId, authentication: input.authentication }))?.capabilities.readTranscript === true;
    }
    if (source.kind === 'discussion') return await resolveDiscussionContextInTx(tx, {
        discussionId: source.discussionId, accountId: input.accountId,
        authentication: input.authentication }) !== null;
    if (input.authentication.apiTokenGrant?.targets != null) return false;
    return await resolveWorkflowRunAccessInTx(tx, { actorAccountId: input.accountId, runId: source.runId }) !== null;
}
