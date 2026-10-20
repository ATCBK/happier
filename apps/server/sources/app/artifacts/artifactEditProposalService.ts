import * as privacyKit from 'privacy-kit';
import type { ArtifactRevisionV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import type { DocEditAcceptTransportInputV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { prepareDocEditBodyV1 } from '@happier-dev/protocol/artifacts/artifactPassageV1';
import { artifactSupportsProseCollaborationV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactBodyEnvelopeV1Schema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { DiscussionDocEditProposalContentV1Schema } from '@happier-dev/protocol/discussions/content';
import { DocEditProposalDispositionV1Schema, type DocEditProposalDispositionV1 } from '@happier-dev/protocol/discussions/models';
import { DiscussionMessageRefV1Schema, type DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { acquireDiscussionMutationAccountsInTx, resolveDiscussionAudienceInTx, resolveDiscussionContextInTx } from '@/app/discussions/access';
import { discoverDocEditProposalSourceInTx, readDocEditProposalInTx, setDocEditProposalDispositionInTx, type StoredDocEditProposal } from '@/app/discussions/docEditProposals';
import type { DiscussionFailureCode } from '@/app/discussions/serviceTypes';
import { inTx, TransactionReplayRequiredError, type Tx } from '@/storage/inTx';
import { acquireArtifactPublicationLocksInTx, projectPlainArtifactSharingResourceV1, readArtifactForCallerInTx, type ArtifactForCaller } from './artifactAccessService';
import { updateArtifactTx, type UpdateArtifactResult } from './artifactWriteService';

type SettledDisposition = Exclude<DocEditProposalDispositionV1, { state: 'open' }>;
type ProposalActor = Readonly<{
    actorAccountId: string;
    authentication: SessionAccessAuthentication;
    proposalRef: DiscussionMessageRefV1;
}>;

type ProposalFailure = Readonly<{ ok: false; error: DiscussionFailureCode
    | 'doc_edit_proposal_present_person_required' | 'doc_edit_proposal_invalid'
    | 'doc_edit_proposal_edit_access_required' | 'doc_edit_proposal_prose_required'
    | 'doc_edit_proposal_disposition_unavailable'
    | 'doc_edit_proposal_preparation_required'
    | 'artifact_not_found' | 'artifact_content_unavailable' | 'version-mismatch' }>;
type PreparedArtifactEditProposalDecision = Readonly<{
    ok: true;
    artifactId: string;
    expectedRevision: ArtifactRevisionV1;
    body: Readonly<{ bytes: Uint8Array; expectedVersion: number }>;
}>;
export type ArtifactEditProposalDecisionResult = Readonly<{
    ok: true; disposition: SettledDisposition;
}> & (Readonly<{ artifactUpdate: Extract<UpdateArtifactResult, { ok: true }>; artifactId: string }>
    | Readonly<{ artifactUpdate?: undefined; artifactId?: undefined }>)
    | ProposalFailure | Extract<UpdateArtifactResult, { ok: false }>;

function admitPresentPerson(input: Pick<ProposalActor, 'authentication'>): ProposalFailure | null {
    return input.authentication.authority === 'present_user' && !input.authentication.sessionRuntimePrincipal
        ? null : { ok: false, error: 'doc_edit_proposal_present_person_required' };
}

function parsePlainCandidate(input: ProposalActor, stored: StoredDocEditProposal, artifact: ArtifactForCaller) {
    const { message, source } = stored;
    if (message.id !== input.proposalRef.messageId || message.discussionId !== input.proposalRef.discussion.discussionId
        || message.content.t !== 'plain') return { ok: false, error: 'doc_edit_proposal_invalid' } as const;
    const parsed = createStoredReadSchema(DiscussionDocEditProposalContentV1Schema).safeParse(message.content.v);
    if (!parsed.success || parsed.data.proposal.target.ref.artifactId !== source.ref.artifactId
        || artifact.id !== source.ref.artifactId) return { ok: false, error: 'doc_edit_proposal_invalid' } as const;
    return { ok: true, proposal: parsed.data.proposal, artifact } as const;
}

/** Shared decision admission for execution and source-owned private attention, never inferred by Inbox. */
export async function admitArtifactEditProposalDecisionDocInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; authentication: SessionAccessAuthentication; discussionId: string;
}>, source: StoredDocEditProposal['source']) {
    const denied = admitPresentPerson(input);
    if (denied) return denied;
    const context = await resolveDiscussionContextInTx(tx, { accountId: input.actorAccountId,
        authentication: input.authentication, discussionId: input.discussionId });
    if (!context?.keyReadiness) return { ok: false, error: 'discussion_not_found' } as const;
    const read = await readArtifactForCallerInTx(tx, { actorAccountId: input.actorAccountId, artifactId: source.ref.artifactId });
    if (!read.ok) return read;
    if (read.artifact.access === 'view') return { ok: false, error: 'doc_edit_proposal_edit_access_required' } as const;
    return read;
}

function prepareHostCandidate(stored: StoredDocEditProposal, input: ProposalActor & Readonly<{
    expectedRevision: ArtifactRevisionV1; preparation?: DocEditAcceptTransportInputV1['preparation'];
}>): PreparedArtifactEditProposalDecision | ProposalFailure {
    const preparation = input.preparation;
    if (!preparation) return { ok: false, error: 'doc_edit_proposal_preparation_required' };
    if (preparation.doc.ref.artifactId !== stored.source.ref.artifactId
        || preparation.doc.ref.serverId !== input.proposalRef.discussion.serverId
        || preparation.doc.revision.headerVersion !== input.expectedRevision.headerVersion
        || preparation.doc.revision.bodyVersion !== input.expectedRevision.bodyVersion
        || (stored.message.replyTarget?.kind === 'doc_passage' && (
            preparation.doc.revision.headerVersion !== stored.source.revision.headerVersion
            || preparation.doc.revision.bodyVersion !== stored.source.revision.bodyVersion))) {
        return { ok: false, error: 'doc_edit_proposal_invalid' };
    }
    try {
        return { ok: true, artifactId: stored.source.ref.artifactId, expectedRevision: input.expectedRevision,
            body: { bytes: privacyKit.decodeBase64(preparation.body), expectedVersion: input.expectedRevision.bodyVersion } };
    } catch { return { ok: false, error: 'doc_edit_proposal_invalid' }; }
}

function plainPreparationMatches(prepared: PreparedArtifactEditProposalDecision, preparation: NonNullable<DocEditAcceptTransportInputV1['preparation']>): boolean {
    const body = ArtifactBodyEnvelopeV1Schema.safeParse(decodePlainArtifactStoredContent(preparation.body));
    const expected = ArtifactBodyEnvelopeV1Schema.parse(decodePlainArtifactStoredContent(privacyKit.encodeBase64(new Uint8Array(prepared.body.bytes))));
    return preparation.doc.ref.artifactId === prepared.artifactId
        && preparation.doc.revision.headerVersion === prepared.expectedRevision.headerVersion
        && preparation.doc.revision.bodyVersion === prepared.expectedRevision.bodyVersion
        && body.success && body.data.body === expected.body;
}

function prepareCandidate(candidate: Extract<ReturnType<typeof parsePlainCandidate>, { ok: true }>, expectedRevision: ArtifactRevisionV1): PreparedArtifactEditProposalDecision | ProposalFailure {
    if (expectedRevision.headerVersion !== candidate.proposal.baseRevision.headerVersion
        || expectedRevision.bodyVersion !== candidate.proposal.baseRevision.bodyVersion) return { ok: false, error: 'version-mismatch' };
    const resource = projectPlainArtifactSharingResourceV1(candidate.artifact);
    if (!resource || !artifactSupportsProseCollaborationV1(resource) || typeof resource.body !== 'string') {
        return { ok: false, error: 'doc_edit_proposal_prose_required' };
    }
    try {
        const body = prepareDocEditBodyV1({ proposal: candidate.proposal, ref: candidate.proposal.target.ref,
            revision: { headerVersion: candidate.artifact.headerVersion, bodyVersion: candidate.artifact.bodyVersion }, source: resource.body });
        return { ok: true, artifactId: candidate.artifact.id, expectedRevision,
            body: { bytes: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body })), expectedVersion: expectedRevision.bodyVersion } };
    } catch (error) {
        return { ok: false, error: error instanceof Error && error.message === 'version_mismatch' ? 'version-mismatch' : 'doc_edit_proposal_invalid' };
    }
}

/** Throwing after a lost disposition precondition forces the caller's containing inTx to roll back the body write. */
export class ArtifactEditProposalAtomicityError extends Error {
    constructor() { super('Doc proposal disposition did not settle in the Artifact transaction'); this.name = 'ArtifactEditProposalAtomicityError'; }
}

export type ArtifactEditProposalDecisionInput = ProposalActor & (
    Readonly<{ decision: 'accept' }> & Omit<DocEditAcceptTransportInputV1, 'proposalRef'> | Readonly<{ decision: 'decline' }>
);

/** The canonical public service owns transaction recovery; nested domain callers reuse the same inTx variant. */
export function decideArtifactEditProposal(input: ArtifactEditProposalDecisionInput): Promise<ArtifactEditProposalDecisionResult> {
    return inTx(tx => decideArtifactEditProposalInTx(tx, input), { transactionClass: 'artifact-doc-proposal-decision' });
}

/** Person admission, full Artifact CAS and the exact message disposition commit or roll back together. */
export async function decideArtifactEditProposalInTx(tx: Tx, input: ArtifactEditProposalDecisionInput): Promise<ArtifactEditProposalDecisionResult> {
    const denied = admitPresentPerson(input);
    if (denied) return denied;
    if (!DiscussionMessageRefV1Schema.safeParse(input.proposalRef).success) return { ok: false, error: 'doc_edit_proposal_invalid' };
    const source = await discoverDocEditProposalSourceInTx(tx, input.proposalRef);
    if (source) {
        // The Artifact owner selects the strongest quota intent and admits the
        // complete sorted union before either Artifact or proposal row locking.
        await acquireArtifactPublicationLocksInTx(tx, source.ref.artifactId, [input.actorAccountId,
            ...await resolveDiscussionAudienceInTx(tx, input.proposalRef.discussion.discussionId)]);
    } else {
        await acquireDiscussionMutationAccountsInTx(tx, { actorAccountId: input.actorAccountId,
            discussionId: input.proposalRef.discussion.discussionId });
    }
    const stored = await readDocEditProposalInTx(tx, input);
    if (!stored.ok) return stored;
    if (stored.value.source.ref.artifactId !== source?.ref.artifactId) {
        throw new TransactionReplayRequiredError('transaction-account-audience-changed');
    }
    const doc = await admitArtifactEditProposalDecisionDocInTx(tx, { ...input,
        discussionId: input.proposalRef.discussion.discussionId }, stored.value.source);
    if (!doc.ok) return doc;
    const disposition = DocEditProposalDispositionV1Schema.safeParse(stored.value.message.docEditProposalDispositionV1);
    if (!disposition.success) return { ok: false, error: 'doc_edit_proposal_disposition_unavailable' };
    if (disposition.data.state !== 'open') return { ok: true, disposition: disposition.data };
    let artifactUpdate: Extract<UpdateArtifactResult, { ok: true }> | undefined;
    let next: SettledDisposition;
    const decidedBy = { accountId: input.actorAccountId, atMs: Date.now() };
    if (input.decision === 'accept') {
        let prepared: PreparedArtifactEditProposalDecision | ProposalFailure;
        if (stored.value.message.content.t === 'plain') {
            const candidate = parsePlainCandidate(input, stored.value, doc.artifact);
            if (!candidate.ok) return candidate;
            if (candidate.proposal.baseRevision.headerVersion !== input.expectedRevision.headerVersion
                || candidate.proposal.baseRevision.bodyVersion !== input.expectedRevision.bodyVersion) return { ok: false, error: 'version-mismatch' };
            if (doc.artifact.encryptionMode === 'plain') {
                prepared = prepareCandidate(candidate, input.expectedRevision);
                if (prepared.ok && input.preparation && (input.preparation.doc.ref.serverId !== input.proposalRef.discussion.serverId
                    || !plainPreparationMatches(prepared, input.preparation))) return { ok: false, error: 'doc_edit_proposal_invalid' };
            } else prepared = prepareHostCandidate(stored.value, input);
        } else prepared = prepareHostCandidate(stored.value, input);
        if (!prepared.ok) return prepared;
        const updated = await updateArtifactTx(tx, { actorUserId: input.actorAccountId, artifactId: prepared.artifactId,
            expectedRevision: prepared.expectedRevision, body: prepared.body, authentication: input.authentication });
        if (!updated.ok) return updated;
        if (!updated.body) throw new ArtifactEditProposalAtomicityError();
        artifactUpdate = updated;
        next = { state: 'accepted', acceptedRevision: { headerVersion: prepared.expectedRevision.headerVersion,
            bodyVersion: updated.body.version }, decidedBy };
    } else next = { state: 'declined', decidedBy };
    if (!await setDocEditProposalDispositionInTx(tx, { proposalRef: input.proposalRef, expectedDisposition: 'open', disposition: next })) {
        throw new ArtifactEditProposalAtomicityError();
    }
    return artifactUpdate ? { ok: true, disposition: next, artifactUpdate, artifactId: doc.artifact.id }
        : { ok: true, disposition: next };
}
