import { approvalArtifactBodyMatchesHeaderV1, type ParsedApprovalArtifactBodyV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { ApprovalRequest, ApprovalRequesterConfirmationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { isDiscussionActionIdV1 } from '@happier-dev/protocol/discussions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';

import type { DecryptedArtifact } from './artifactTypes';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

export type OpenApprovalArtifactForSession = Readonly<{
    /** Card routing/Home facts only. Current grants and detail content stay with the Artifact owner. */
    artifact: Pick<DecryptedArtifact, 'id' | 'header'>;
    approval: ApprovalRequest;
}>;

export type OpenApprovalSessionReference = Readonly<
    | { kind: 'exact'; address: SessionAddress }
    | { kind: 'legacy_unscoped'; sessionId: string }
>;

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

type SessionReferenceFact = Readonly<{
    reference: OpenApprovalSessionReference;
    sortKey: string;
}> & { addressKey?: string };
type SessionReferenceIndex = Map<string | null, Map<string, SessionReferenceFact>>;

function addSessionReference(
    references: SessionReferenceIndex,
    value: unknown,
    serverId?: unknown,
): void {
    const sessionId = readString(value);
    if (!sessionId) return;
    const normalizedServerId = readString(serverId);
    const sessions = references.get(normalizedServerId) ?? new Map<string, SessionReferenceFact>();
    if (sessions.has(sessionId)) return;
    const reference: OpenApprovalSessionReference = normalizedServerId
        ? { kind: 'exact', address: { serverId: normalizedServerId, sessionId } }
        : { kind: 'legacy_unscoped', sessionId };
    // Preserve the incumbent reference ordering/key only once, at immutable-fact derivation.
    sessions.set(sessionId, { reference, sortKey: JSON.stringify(reference) });
    references.set(normalizedServerId, sessions);
}

function collectSessionReferencesFromUnknownArray(
    references: SessionReferenceIndex,
    value: unknown,
    serverId?: unknown,
): void {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
        addSessionReference(references, entry, serverId);
    }
}

type AdmittedApprovalArtifactSnapshot = Readonly<{
    parsed: ParsedApprovalArtifactBodyV1 | null;
    sessionEntry: OpenApprovalArtifactForSession | null;
    references: readonly SessionReferenceFact[];
}>;

type ApprovalArtifactSnapshot = {
    header: NonNullable<DecryptedArtifact['header']>;
    sessions: DecryptedArtifact['sessions'];
    body: string | null;
    headerReferences: readonly SessionReferenceFact[];
    admitted?: AdmittedApprovalArtifactSnapshot;
};

// The Artifact producer retains unchanged header/body slices. Admit that immutable input once,
// including refusals; metadata-only snapshots reuse admission, not membership or presentation.
// Each header retains only its current body. Weak keys release removed snapshots with their owner.
const admittedApprovalBodies = new WeakMap<ApprovalArtifactSnapshot['header'], Readonly<{
    body: string | null;
    parsed: ParsedApprovalArtifactBodyV1 | null;
    sessionEntry: OpenApprovalArtifactForSession | null;
}>>();
const approvalArtifactSnapshots = new WeakMap<DecryptedArtifact, ApprovalArtifactSnapshot>();

function readApprovalArtifactProjection(artifact: DecryptedArtifact): ApprovalArtifactSnapshot | null {
    const header = artifact.header;
    if (!header) return null;
    const body = typeof artifact.body === 'string' ? artifact.body : null;
    const previous = approvalArtifactSnapshots.get(artifact);
    if (previous?.header === header && previous.sessions === artifact.sessions && previous.body === body) return previous;
    const references: SessionReferenceIndex = new Map();
    // These are facts, not authorization: portable Home aliases/membership stay in the live matcher.
    const serverId = readString(header.serverIdentityId) ?? readString(header.serverId);
    addSessionReference(references, header.sessionId, serverId);
    collectSessionReferencesFromUnknownArray(references, artifact.sessions, serverId);
    collectSessionReferencesFromUnknownArray(references, header.sessions, serverId);
    const snapshot: ApprovalArtifactSnapshot = { header, sessions: artifact.sessions, body,
        headerReferences: [...references.values()].flatMap(sessions => [...sessions.values()]) };
    approvalArtifactSnapshots.set(artifact, snapshot);
    return snapshot;
}

function readApprovalArtifactSnapshot(artifact: DecryptedArtifact): AdmittedApprovalArtifactSnapshot | null {
    const snapshot = readApprovalArtifactProjection(artifact);
    if (!snapshot) return null;
    if (snapshot.admitted) return snapshot.admitted;
    const admitted = admittedApprovalBodies.get(snapshot.header);
    const parsed = admitted?.body === snapshot.body ? admitted.parsed
        : approvalArtifactBodyMatchesHeaderV1(snapshot.header, snapshot.body);
    // HTTP grant/kind/provenance enrichment is not a change to the card's admitted facts.
    // Carry this narrow producer value with admission, never stale Artifact authority.
    const sessionEntry = parsed?.family === 'built_in'
        ? admitted?.parsed === parsed && admitted.sessionEntry?.artifact.id === artifact.id
            ? admitted.sessionEntry
            : { artifact: { id: artifact.id, header: snapshot.header }, approval: parsed.request }
        : null;
    if (!admitted || admitted.body !== snapshot.body || admitted.sessionEntry !== sessionEntry) {
        admittedApprovalBodies.set(snapshot.header, { body: snapshot.body, parsed, sessionEntry });
    }
    snapshot.admitted = { parsed, sessionEntry,
        references: collectApprovalLinkedSessionReferences(snapshot, sessionEntry?.approval) };
    return snapshot.admitted;
}

function readOpenApprovalInboxArtifact(artifact: DecryptedArtifact) {
    if (artifact.draft === true || artifact.header?.approvalStatus !== 'open'
        || !Object.values(APPROVAL_ARTIFACT_KINDS_V1).some(kind => kind === artifact.header?.kind)) return null;
    const parsed = readApprovalArtifactSnapshot(artifact)?.parsed;
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
    const parsed = readApprovalArtifactSnapshot(artifact)?.parsed;
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
    snapshot: ApprovalArtifactSnapshot,
    approval?: ApprovalRequest | null,
): readonly SessionReferenceFact[] {
    const references: SessionReferenceIndex = new Map();
    for (const fact of snapshot.headerReferences) {
        const reference = fact.reference;
        const serverId = reference.kind === 'exact' ? reference.address.serverId : null;
        const sessionId = reference.kind === 'exact' ? reference.address.sessionId : reference.sessionId;
        const sessions = references.get(serverId) ?? new Map<string, SessionReferenceFact>();
        sessions.set(sessionId, fact);
        references.set(serverId, sessions);
    }
    if (approval?.v === 2) {
        addSessionReference(
            references,
            approval.executionOriginV1.sessionId ?? approval.createdBy.sessionId,
            approval.executionOriginV1.serverIdentityId ?? approval.executionOriginV1.serverId,
        );
    } else {
        addSessionReference(references, approval?.createdBy.sessionId,
            readString(snapshot.header.serverIdentityId) ?? readString(snapshot.header.serverId));
    }
    return [...references.values()].flatMap(sessions => [...sessions.values()]);
}

function referenceMatchesTarget(
    fact: SessionReferenceFact,
    target: SessionAddress | string,
    knownSessionAddresses: readonly SessionAddress[],
): boolean {
    const reference = fact.reference;
    if (reference.kind === 'exact') {
        return typeof target === 'string'
            ? (fact.addressKey ??= sessionAddressKey(reference.address)) === target.trim()
            : reference.address.sessionId === target.sessionId
                && areServerProfileIdentifiersEquivalent(reference.address.serverId, target.serverId);
    }
    if (typeof target === 'string' || reference.sessionId !== target.sessionId) return false;
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
        && readApprovalArtifactProjection(artifact)?.headerReferences.some(reference => referenceMatchesTarget(reference, target, knownSessionAddresses)))
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
        // The strict reader requires the body's Session binding to match this
        // index. Unrelated headers cannot admit a body for this Session; avoid
        // reparsing every Account approval when its inventory changes.
        const snapshot = readApprovalArtifactProjection(artifact);
        if (!snapshot?.headerReferences.some(reference => (
            referenceMatchesTarget(reference, target, knownSessionAddresses)
        ))) return [];
        const admitted = readApprovalArtifactSnapshot(artifact);
        if (!admitted?.sessionEntry) return [];
        const entry = admitted.sessionEntry;
        const { approval } = entry;
        if (approval.status === 'open' ? artifact.header?.approvalStatus !== 'open' : !keepsSettled?.(approval)) return [];
        return [entry];
    });
}

export function collectOpenApprovalSessionReferences(
    artifacts: readonly DecryptedArtifact[],
    previousReferences: readonly OpenApprovalSessionReference[] = [],
): readonly OpenApprovalSessionReference[] {
    const referencesByKey = new Map<string, SessionReferenceFact>();
    // Reconcile the output facts at their producer, including removal of the first of several
    // approvals for one Session. This baseline contains references only, never Artifact inventory
    // or resolved Home authorization. It replaces the hook's whole-output signature comparison.
    const previousByHome = new Map<string | null, Map<string, OpenApprovalSessionReference>>();
    for (const reference of previousReferences) {
        const home = reference.kind === 'exact' ? reference.address.serverId : null;
        const sessionId = reference.kind === 'exact' ? reference.address.sessionId : reference.sessionId;
        const sessions = previousByHome.get(home) ?? new Map<string, OpenApprovalSessionReference>();
        sessions.set(sessionId, reference);
        previousByHome.set(home, sessions);
    }

    for (const artifact of artifacts) {
        if (artifact.header?.kind !== 'approval_request.v1') continue;
        if (artifact.header?.approvalStatus !== 'open') continue;

        const admitted = readApprovalArtifactSnapshot(artifact);
        const approval = admitted?.sessionEntry?.approval;
        // The list badge is an index projection and must survive the normal
        // header-before-body hydration window. Once a body is present it must
        // validate and remain open; malformed or closed bodies fail closed.
        if (artifact.body != null && approval?.status !== 'open') continue;

        for (const fact of admitted?.references ?? []) {
            if (!referencesByKey.has(fact.sortKey)) referencesByKey.set(fact.sortKey, fact);
        }
    }

    return [...referencesByKey.values()].sort((left, right) => left.sortKey.localeCompare(right.sortKey))
        .map(({ reference }) => {
            const home = reference.kind === 'exact' ? reference.address.serverId : null;
            const sessionId = reference.kind === 'exact' ? reference.address.sessionId : reference.sessionId;
            return previousByHome.get(home)?.get(sessionId) ?? reference;
        });
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
