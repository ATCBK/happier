import { CoordinationMessageRefV1Schema, type CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import type { MemoryDecisionSourceErrorCodeV1 } from '@happier-dev/protocol/prompts/library/memoryActionsV1';
import type { Tx } from '@/storage/inTx';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { mayInjectResourceContextInTx, type ContextDisclosureResource, type ResourceContextStorageAdapter } from '@/app/session/access/sessionContextInjection';
import { readCommittedSessionMessageInTx } from '@/app/session/messages/readCommittedSessionMessage';
import { readDiscussionMessageInTx } from '@/app/discussions/queries';
import { discussionContextStorageAdapter } from '@/app/discussions/access';
import { admitDiscussionDocSourceInTx, resolveDiscussionDocTargetInTx } from '@/app/discussions/docPassages';

export type MemoryDecisionAdmissionError = MemoryDecisionSourceErrorCodeV1;
export interface ArtifactMemoryDecisionWriteContext {
    memoryDecisionSource?: CoordinationMessageRefV1;
    authentication?: SessionAccessAuthentication;
}

/** Admit source existence, current read access and the whole destination audience before writing opaque content. */
export async function admitArtifactMemoryDecisionInTx(tx: Tx, input: ArtifactMemoryDecisionWriteContext & Readonly<{
    actorAccountId: string; artifactId: string; destinationAdapter: ResourceContextStorageAdapter;
}>): Promise<MemoryDecisionAdmissionError | null> {
    if (input.memoryDecisionSource === undefined) return null;
    const parsed = CoordinationMessageRefV1Schema.safeParse(input.memoryDecisionSource);
    if (!parsed.success || !input.authentication) return 'memory_decision_source_unavailable';
    const source = parsed.data;
    if (source.kind === 'discussion') {
        const committed = await readDiscussionMessageInTx(tx, { actorAccountId: input.actorAccountId,
            authentication: input.authentication, discussionId: source.discussion.discussionId, messageId: source.messageId });
        if (!committed.ok) return 'memory_decision_source_unavailable';
        const destination: ContextDisclosureResource = { kind: 'resource', resourceId: input.artifactId, adapter: input.destinationAdapter };
        // Discussion membership does not grant access to its independently protected Doc.
        const docSource = await resolveDiscussionDocTargetInTx(tx, { discussionId: source.discussion.discussionId,
            replyTarget: committed.value.replyTarget });
        if (!docSource.ok) return 'memory_decision_source_unavailable';
        const docAdmission = await admitDiscussionDocSourceInTx(tx, { actorAccountId: input.actorAccountId,
            authentication: input.authentication, source: docSource.value, destination });
        if (!docAdmission.ok) return docAdmission.error === 'discussion_content_unavailable'
            ? 'memory_decision_source_unavailable' : 'memory_decision_disclosure_denied';
        const disclosure = await mayInjectResourceContextInTx(tx, { configuringAccountId: input.actorAccountId,
            authentication: input.authentication,
            source: { kind: 'resource', resourceId: source.discussion.discussionId, adapter: discussionContextStorageAdapter },
            destination });
        return disclosure.ok ? null : 'memory_decision_disclosure_denied';
    }
    const committed = await readCommittedSessionMessageInTx(tx, { accountId: input.actorAccountId,
        sessionId: source.session.sessionId, messageId: source.messageId, authentication: input.authentication });
    if (committed.accessDecision.status !== 'allowed' || !committed.row
        || !SessionStoredMessageContentSchema.safeParse(committed.row.content).success) return 'memory_decision_source_unavailable';
    const disclosure = await mayInjectResourceContextInTx(tx, { configuringAccountId: input.actorAccountId,
        authentication: input.authentication, source: { kind: 'session', sessionId: source.session.sessionId },
        destination: { kind: 'resource', resourceId: input.artifactId, adapter: input.destinationAdapter } });
    return disclosure.ok ? null : 'memory_decision_disclosure_denied';
}
