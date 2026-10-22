import { approvalArtifactBodyMatchesHeaderV1, type ParsedApprovalArtifactBodyV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { ApprovalRequest, ApprovalRequesterConfirmationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { isDiscussionActionIdV1 } from '@happier-dev/protocol/discussions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import type { DecryptedArtifact } from './artifactTypes';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

export type OpenApprovalArtifactForSession = Readonly<{
    artifact: DecryptedArtifact;
    approval: ApprovalRequest;
}>;

export type OpenApprovalSessionReference = Readonly<
    | { kind: 'exact'; address: SessionAddress }
    | { kind: 'legacy_unscoped'; sessionId: string }
>;

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function addSessionReference(
    referencesByKey: Map<string, OpenApprovalSessionReference>,
    value: unknown,
    serverId?: unknown,
): void {
    const sessionId = readString(value);
    if (!sessionId) return;
    const normalizedServerId = readString(serverId);
    const reference: OpenApprovalSessionReference = normalizedServerId
        ? { kind: 'exact', address: { serverId: normalizedServerId, sessionId } }
        : { kind: 'legacy_unscoped', sessionId };
    referencesByKey.set(JSON.stringify(reference), reference);
}

function collectSessionReferencesFromUnknownArray(
    referencesByKey: Map<string, OpenApprovalSessionReference>,
    value: unknown,
    serverId?: unknown,
): void {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
        addSessionReference(referencesByKey, entry, serverId);
    }
}

function parseApprovalRequestArtifact(artifact: DecryptedArtifact): ApprovalRequest | null {
    const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, typeof artifact.body === 'string' ? artifact.body : null);
    return parsed?.family === 'built_in' ? parsed.request : null;
}

function readOpenApprovalInboxArtifact(artifact: DecryptedArtifact) {
    if (artifact.draft === true) return null;
    const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, typeof artifact.body === 'string' ? artifact.body : null);
    return parsed?.request.status === 'open' ? parsed : null;
}

/**
 * The open Ask already filed for one managed resource's Action (a Delete waiting in Inbox). Read from the
 * Inbox's strict private request, newest first; the header prefilter keeps unrelated artifacts unparsed.
 */
export function readOpenManagedMachineApprovalId(
    artifacts: Iterable<DecryptedArtifact>,
    target: Readonly<{ homeId: string; managedId: string; actionId: string }>,
): string | null {
    let found: { id: string; createdAtMs: number } | null = null;
    for (const artifact of artifacts) {
        if (artifact.header?.actionId !== target.actionId || artifact.header?.approvalStatus !== 'open') continue;
        const parsed = readOpenApprovalInboxArtifact(artifact);
        if (parsed?.family !== 'built_in') continue;
        const args = parsed.request.actionArgs;
        if (!args || typeof args !== 'object' || !('managedId' in args) || args.managedId !== target.managedId
            || !('homeId' in args) || args.homeId !== target.homeId) continue;
        if (!found || parsed.request.createdAtMs > found.createdAtMs) found = { id: artifact.id, createdAtMs: parsed.request.createdAtMs };
    }
    return found?.id ?? null;
}

export type ApprovalDiscussionAddress = Readonly<{ serverId: string; discussionId: string }>;
export type OpenApprovalDiscussionAttention = ApprovalDiscussionAddress & Readonly<{
    reason: 'approval_pending' | 'draft_waiting';
}>;

/** The Inbox's strict private request is the only source of this Discussion link. */
export function readOpenApprovalDiscussionAttention(artifact: DecryptedArtifact): OpenApprovalDiscussionAttention | null {
    const parsed = readOpenApprovalInboxArtifact(artifact);
    if (parsed?.family !== 'built_in' || parsed.request.v !== 2 || !isDiscussionActionIdV1(parsed.request.actionId)) return null;
    const request = parsed.request;
    const input = getActionSpec(request.actionId).inputSchema.safeParse(request.actionArgs);
    if (!input.success || typeof input.data !== 'object' || input.data === null || !('discussionId' in input.data)
        || typeof input.data.discussionId !== 'string') return null;
    const serverId = request.executionOriginV1.serverIdentityId ?? request.executionOriginV1.serverId;
    return { serverId, discussionId: input.data.discussionId,
        reason: request.discussionDraftReview === true ? 'draft_waiting' : 'approval_pending' };
}

/**
 * A shared Bot's outward request that waits for the person who asked, joined to the Discussion
 * message that asked it. The admitted cause (`executionOriginV1.actionRequestAttributionV1`) is the
 * only source of the link; nothing is inferred from the thread. Every status is kept, so the card
 * becomes the request's receipt in place once it is decided.
 */
export type DiscussionRequesterApproval = Readonly<{
    artifact: DecryptedArtifact;
    parsed: Extract<ParsedApprovalArtifactBodyV1, { family: 'built_in' | 'target_action' }>;
    subject: ApprovalRequesterConfirmationV1;
    /** The admitted cause; a Bot reply stamped with the same ref is the answer to this ask. */
    requestRef: string;
    originMessageId: string;
}>;

function readDiscussionRequesterApproval(
    artifact: DecryptedArtifact,
    discussion: ApprovalDiscussionAddress,
): DiscussionRequesterApproval | null {
    if (artifact.draft === true || typeof artifact.body !== 'string') return null;
    const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body);
    if (!parsed || parsed.family === 'execution_run_host_action') return null;
    const request = parsed.family === 'target_action' ? parsed.request : parsed.request.v === 2 ? parsed.request : null;
    if (!request) return null;
    const subject = request.requesterConfirmation;
    const cause = request.executionOriginV1?.actionRequestAttributionV1;
    const origin = cause?.origin;
    if (!subject || !cause || origin?.kind !== 'discussion') return null;
    if (origin.discussion.discussionId !== discussion.discussionId
        || !areServerProfileIdentifiersEquivalent(origin.discussion.serverId, discussion.serverId)) return null;
    return { artifact, parsed, subject, requestRef: cause.requestRef, originMessageId: origin.messageId };
}

export function listDiscussionRequesterApprovals(
    artifacts: readonly DecryptedArtifact[],
    discussion: ApprovalDiscussionAddress,
): DiscussionRequesterApproval[] {
    return artifacts.flatMap((artifact) => {
        const entry = readDiscussionRequesterApproval(artifact, discussion);
        return entry ? [entry] : [];
    }).sort((left, right) => left.parsed.request.createdAtMs - right.parsed.request.createdAtMs
        || left.artifact.id.localeCompare(right.artifact.id));
}

export function isOpenApprovalInboxArtifact(artifact: DecryptedArtifact): boolean {
    return readOpenApprovalInboxArtifact(artifact) !== null;
}

/** Header-only open Asks are candidates, not decisions: demand their authoritative bodies before Inbox admission. */
export function listOpenApprovalInboxArtifactHydrationRequests(
    artifacts: Iterable<DecryptedArtifact>,
    fallbackServerId?: string | null,
): readonly Readonly<{ artifactId: string; serverId: string }>[] {
    const requests = new Map<string, Readonly<{ artifactId: string; serverId: string }>>();
    for (const artifact of artifacts) {
        if (artifact.draft === true || artifact.isDecrypted !== true || artifact.body !== undefined
            || artifact.header?.kind !== 'approval_request.v1' || artifact.header.approvalStatus !== 'open') continue;
        const serverId = readString(artifact.header.serverIdentityId) ?? readString(artifact.header.serverId)
            ?? readString(fallbackServerId);
        if (!serverId || requests.has(artifact.id)) continue;
        requests.set(artifact.id, { artifactId: artifact.id, serverId });
    }
    return [...requests.values()];
}

function collectApprovalLinkedSessionReferences(
    artifact: DecryptedArtifact,
    approval?: ApprovalRequest | null,
): readonly OpenApprovalSessionReference[] {
    const referencesByKey = new Map<string, OpenApprovalSessionReference>();
    // A producer's profile id is device-local. Its portable Home identity is
    // the cross-device link; profile aliases are resolved only when matching.
    const serverId = readString(artifact.header?.serverIdentityId) ?? readString(artifact.header?.serverId);
    addSessionReference(referencesByKey, artifact.header?.sessionId, serverId);
    collectSessionReferencesFromUnknownArray(referencesByKey, artifact.sessions, serverId);
    collectSessionReferencesFromUnknownArray(referencesByKey, artifact.header?.sessions, serverId);
    if (approval?.v === 2) {
        addSessionReference(
            referencesByKey,
            approval.executionOriginV1.sessionId ?? approval.createdBy.sessionId,
            approval.executionOriginV1.serverIdentityId ?? approval.executionOriginV1.serverId,
        );
    } else {
        addSessionReference(referencesByKey, approval?.createdBy.sessionId, serverId);
    }
    return [...referencesByKey.values()];
}

function referenceMatchesTarget(
    reference: OpenApprovalSessionReference,
    target: SessionAddress | string,
    knownSessionAddresses: readonly SessionAddress[],
): boolean {
    if (reference.kind === 'exact') {
        const key = sessionAddressKey(reference.address);
        return typeof target === 'string'
            ? key === target.trim()
            : reference.address.sessionId === target.sessionId
                && areServerProfileIdentifiersEquivalent(reference.address.serverId, target.serverId);
    }
    if (typeof target === 'string') return false;
    const candidates = new Map(
        knownSessionAddresses
            .filter((address) => address.sessionId === reference.sessionId)
            .map((address) => [resolveServerProfileScopeIdForIdentifier(address.serverId), address] as const),
    );
    return candidates.size === 1 && candidates.has(resolveServerProfileScopeIdForIdentifier(target.serverId));
}

/** Read demand only; admission still requires the strict body/header reader. */
export function listApprovalArtifactIdsNeedingHydrationForSession(
    artifacts: readonly DecryptedArtifact[],
    target: SessionAddress,
    knownSessionAddresses: readonly SessionAddress[],
): string[] {
    return artifacts.filter(artifact => artifact.draft !== true && artifact.isDecrypted
        && artifact.header?.kind === 'approval_request.v1' && artifact.body === undefined
        && collectApprovalLinkedSessionReferences(artifact).some(reference => referenceMatchesTarget(reference, target, knownSessionAddresses)))
        .map(artifact => artifact.id);
}

/**
 * An approval body's declaration that its request keeps rendering in the transcript after it is
 * decided (its receipt, or its declined line). Contributed by the body owner; the projection never
 * reads Action ids.
 */
export type ApprovalSettledPresentation = (approval: ApprovalRequest) => boolean;

export function listOpenApprovalArtifactsForSession(
    artifacts: readonly DecryptedArtifact[],
    target: SessionAddress | string,
    options?: Readonly<{ knownSessionAddresses?: readonly SessionAddress[] }>,
): OpenApprovalArtifactForSession[] {
    return listSessionApprovalArtifacts(artifacts, target, options?.knownSessionAddresses ?? [], null);
}

/**
 * The transcript's approvals: every open request, plus settled requests whose body declares a
 * settled presentation. Counts, badges and the composer keep the open projection above.
 */
export function listTranscriptApprovalArtifactsForSession(
    artifacts: readonly DecryptedArtifact[],
    target: SessionAddress | string,
    options?: Readonly<{
        knownSessionAddresses?: readonly SessionAddress[];
        settledPresentations?: readonly ApprovalSettledPresentation[];
    }>,
): OpenApprovalArtifactForSession[] {
    const presentations = options?.settledPresentations ?? [];
    return listSessionApprovalArtifacts(artifacts, target, options?.knownSessionAddresses ?? [],
        presentations.length > 0 ? (approval) => presentations.some((presents) => presents(approval)) : null);
}

function listSessionApprovalArtifacts(
    artifacts: readonly DecryptedArtifact[],
    target: SessionAddress | string,
    knownSessionAddresses: readonly SessionAddress[],
    keepsSettled: ApprovalSettledPresentation | null,
): OpenApprovalArtifactForSession[] {
    if (typeof target === 'string' && !target.trim()) return [];

    return artifacts.flatMap((artifact) => {
        if (artifact.header?.kind !== 'approval_request.v1') return [];
        if (artifact.header?.approvalStatus !== 'open' && !keepsSettled) return [];
        const approval = parseApprovalRequestArtifact(artifact);
        if (!approval) return [];
        if (approval.status === 'open' ? artifact.header?.approvalStatus !== 'open' : !keepsSettled?.(approval)) return [];
        if (!collectApprovalLinkedSessionReferences(artifact, approval).some((reference) => (
            referenceMatchesTarget(reference, target, knownSessionAddresses)
        ))) return [];

        return [{ artifact, approval }];
    });
}

export function collectOpenApprovalSessionReferences(
    artifacts: readonly DecryptedArtifact[],
): readonly OpenApprovalSessionReference[] {
    const referencesByKey = new Map<string, OpenApprovalSessionReference>();

    for (const artifact of artifacts) {
        if (artifact.header?.kind !== 'approval_request.v1') continue;
        if (artifact.header?.approvalStatus !== 'open') continue;

        const approval = parseApprovalRequestArtifact(artifact);
        // The list badge is an index projection and must survive the normal
        // header-before-body hydration window. Once a body is present it must
        // validate and remain open; malformed or closed bodies fail closed.
        if (artifact.body != null && approval?.status !== 'open') continue;

        for (const reference of collectApprovalLinkedSessionReferences(artifact, approval)) {
            referencesByKey.set(JSON.stringify(reference), reference);
        }
    }

    return [...referencesByKey.values()].sort((left, right) => (
        JSON.stringify(left).localeCompare(JSON.stringify(right))
    ));
}

export function resolveOpenApprovalSessionKeys(
    references: readonly OpenApprovalSessionReference[],
    knownSessionAddresses: readonly SessionAddress[],
): ReadonlySet<string> {
    const keys = new Set<string>();
    const addressesBySessionId = new Map<string, Map<string, SessionAddress>>();
    for (const address of knownSessionAddresses) {
        const candidates = addressesBySessionId.get(address.sessionId) ?? new Map<string, SessionAddress>();
        candidates.set(sessionAddressKey(address), address);
        addressesBySessionId.set(address.sessionId, candidates);
    }
    for (const reference of references) {
        if (reference.kind === 'exact') {
            const matching = knownSessionAddresses.filter(address => address.sessionId === reference.address.sessionId
                && areServerProfileIdentifiersEquivalent(address.serverId, reference.address.serverId));
            if (matching.length > 0) for (const address of matching) keys.add(sessionAddressKey(address));
            else keys.add(sessionAddressKey(reference.address));
            continue;
        }
        const candidates = addressesBySessionId.get(reference.sessionId);
        if (candidates?.size === 1) keys.add(candidates.keys().next().value!);
    }
    return keys;
}
