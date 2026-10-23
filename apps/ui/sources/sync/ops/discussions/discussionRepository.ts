import type {
    SessionDraftAddressV2,
    DiscussionCreateResultV1,
    DiscussionDetailsResultV1,
    DiscussionListInputV1,
    DiscussionListResultV1,
    DiscussionMessageContentV1,
    DiscussionOpenedMessageV1,
    DiscussionOpenedSummaryV1,
    DiscussionPostResultV1,
    DiscussionReadStateResultV1,
} from '@happier-dev/protocol';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionDraftCurrentness } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { createDiscussionClient, DiscussionClientOutcome } from '@/sync/api/discussions/discussionActions';
import { watchMountedDiscussions, type MountedDiscussionChangeWatch } from '@/sync/domains/discussions/discussionChangeWatch';
import type { DiscussionAnchorV1, DiscussionReplyTargetV1 } from '@happier-dev/protocol/discussions/replyTargets';
import type { DiscussionCreateInputV1 } from '@happier-dev/protocol/discussions/actions';
import type { DiscussionInitialParticipantV1 } from '@happier-dev/protocol/discussions/participants';
import { DISCUSSION_NOT_TRACKED_CODE_V1 } from '@happier-dev/protocol/discussions/api';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import type { DiscussionAttentionResultV1 } from '@happier-dev/protocol/discussions/actions';
import type { DiscussionAttentionQueryV1 } from '@happier-dev/protocol/discussions/api';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';

export type DiscussionRepositoryClient = Readonly<Pick<ReturnType<typeof createDiscussionClient>,
    'participants' | 'setParticipantPolicy' | 'invite' | 'inviteExecutableParticipant' | 'removeParticipant' | 'leave' | 'transferOwner' | 'listGrants' | 'setGrant' | 'removeGrant' | 'getSettings' | 'setSettings'> & {
    attention(input?: DiscussionAttentionQueryV1, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionAttentionResultV1>>;
    list(input?: DiscussionListInputV1, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionListResultV1>>;
    get(discussionId: string, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionDetailsResultV1>>;
    read: ReturnType<typeof createDiscussionClient>['read'];
    create(input: Readonly<{ creationLocalId: string; messageLocalId: string; title: string; content: DiscussionMessageContentV1; mentionedAccountIds?: readonly string[]; mentionedSessionIds?: readonly string[]; anchor?: DiscussionAnchorV1; participants?: readonly NonNullable<DiscussionCreateInputV1['participants']>[number][]; onResolvedParticipants?: (participants: readonly DiscussionInitialParticipantV1[]) => void; replyTarget?: DiscussionReplyTargetV1 }>, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionCreateResultV1>>;
    post(input: Readonly<{ discussionId: string; localId: string; content: DiscussionMessageContentV1; mentionedAccountIds?: readonly string[]; mentionedSessionIds?: readonly string[]; replyTarget?: DiscussionReplyTargetV1 }>, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionPostResultV1>>;
    rename(discussionId: string, title: string, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionDetailsResultV1>>;
    archive(discussionId: string, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionDetailsResultV1>>;
    restore(discussionId: string, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionDetailsResultV1>>;
    readState(discussionId: string, lastReadSeq: number, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionReadStateResultV1>>;
}>;

export type DiscussionRepositoryStatus = 'idle' | 'loading' | 'ready' | 'offline' | 'locked' | 'error' | 'revoked';
export type DiscussionMutationStatus = 'sending' | 'checking' | 'outcome_unknown' | 'approval_pending' | 'failed' | 'observed_success';
/**
 * How a settled failure can be left behind: a transient failure keeps its
 * identity for an explicit retry, a definitive refusal is dismissed and the
 * retained draft is sent again as a fresh attempt.
 */
export type DiscussionMutationRecovery = 'retry' | 'dismiss';

export type DiscussionDraftSubmission = Readonly<{
    scope: ServerAccountScope;
    address: Extract<SessionDraftAddressV2, { kind: 'discussion' | 'newDiscussion' }>;
    currentness: SessionDraftCurrentness;
}>;

type CreateIntent = Readonly<{
    kind: 'create';
    creationLocalId: string;
    messageLocalId: string;
    title: string;
    content: DiscussionMessageContentV1;
    mentionedAccountIds?: readonly string[];
    mentionedSessionIds?: readonly string[];
    anchor?: DiscussionAnchorV1;
    participants?: readonly NonNullable<DiscussionCreateInputV1['participants']>[number][];
    replyTarget?: DiscussionReplyTargetV1;
    draftSubmission: DiscussionDraftSubmission;
}>;

type PostIntent = Readonly<{
    kind: 'post';
    discussionId: string;
    localId: string;
    content: DiscussionMessageContentV1;
    mentionedAccountIds?: readonly string[];
    mentionedSessionIds?: readonly string[];
    replyTarget?: DiscussionReplyTargetV1;
    draftSubmission: DiscussionDraftSubmission;
}>;

type MutationIntent = CreateIntent | PostIntent;

export type DiscussionRepositoryMutation = Readonly<{
    kind: MutationIntent['kind'];
    localId: string;
    messageLocalId?: string;
    discussionId?: string;
    status: DiscussionMutationStatus;
    artifactId?: string;
    errorCode?: string;
    recovery?: DiscussionMutationRecovery;
    content: DiscussionMessageContentV1;
    mentionedAccountIds?: readonly string[];
    mentionedSessionIds?: readonly string[];
    draftSubmission: DiscussionDraftSubmission;
}>;

type ListPage = Readonly<{
    requestCursor: string | null;
    rows: readonly DiscussionOpenedSummaryV1[];
    nextCursor: string | null;
    incomplete: boolean;
}>;

// Strings preserve the incumbent Session query API; Doc queries use the same
// retained pages, admission and mounted invalidation owner.
type ListAnchor = string | Readonly<{ anchorDocArtifactId: string }>;
const listAnchorKey = (anchor: ListAnchor) => JSON.stringify(typeof anchor === 'string' ? ['session', anchor] : ['doc', anchor.anchorDocArtifactId]);
const listAnchorInput = (anchor?: ListAnchor) => anchor === undefined ? {} : typeof anchor === 'string' ? { anchorSessionId: anchor } : anchor;

export type DiscussionRepositoryListSnapshot = Readonly<{
    items: readonly DiscussionOpenedSummaryV1[];
    nextCursor: string | null;
    status: DiscussionRepositoryStatus;
    errorCode: string | null;
    incomplete: boolean;
}>;

/** Search only opened display facts. Message bodies, ciphertext and opaque ids are never inputs. */
export function selectDiscussionListSearch(
    list: DiscussionRepositoryListSnapshot,
    query: string,
    sourceLabels: ReadonlyMap<string, readonly string[]>,
    previous?: DiscussionRepositoryListSnapshot,
): DiscussionRepositoryListSnapshot {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return list;
    const matches = list.items.filter(row => [row.title,
        ...(row.participantAccounts ?? []).flatMap(actor => actor.profile
            ? [formatAccountDisplayName(actor.profile), actor.profile.username] : []),
        ...(sourceLabels.get(row.id) ?? []),
    ].some(label => label?.toLocaleLowerCase().includes(needle)));
    const sameItems = (items: readonly DiscussionOpenedSummaryV1[]) => items.length === matches.length
        && items.every((row, index) => row === matches[index]);
    const items = previous && sameItems(previous.items) ? previous.items : sameItems(list.items) ? list.items : matches;
    const incomplete = list.incomplete || list.nextCursor !== null || list.status !== 'ready';
    if (previous && previous.items === items && previous.incomplete === incomplete && previous.status === list.status
        && previous.nextCursor === list.nextCursor && previous.errorCode === list.errorCode) return previous;
    return items === list.items && incomplete === list.incomplete ? list : { ...list, items, incomplete };
}

export type DiscussionRepositoryThreadSnapshot = Readonly<{
    summary: DiscussionOpenedSummaryV1 | null;
    messages: readonly DiscussionOpenedMessageV1[];
    hasMoreOlder: boolean;
    /** The oldest ordinary history-page row; independently opened rows do not advance paging. */
    oldestHistorySeq?: number;
    newestHistorySeq?: number;
    messageSeq: number;
    status: DiscussionRepositoryStatus;
    errorCode: string | null;
    incomplete: boolean;
}>;

/**
 * Whether a query has any archived Discussion at all. `unknown` is the
 * honest answer before a read settles and after one is refused; a reader must
 * never present it as emptiness.
 */
export type DiscussionArchivedExistence = 'unknown' | 'empty' | 'present';

export type DiscussionRepositoryCollectionSnapshot = Readonly<{
    lists: Readonly<Record<'active' | 'archived', DiscussionRepositoryListSnapshot>>;
    archivedExistence: DiscussionArchivedExistence;
}>;

export type DiscussionRepositorySnapshot = DiscussionRepositoryCollectionSnapshot & Readonly<{
    address: Readonly<{ serverId: string }>;
    anchors: Readonly<Record<string, DiscussionRepositoryCollectionSnapshot>>;
    threads: Readonly<Record<string, DiscussionRepositoryThreadSnapshot>>;
    mutations: Readonly<Record<string, DiscussionRepositoryMutation>>;
    attention: DiscussionRepositoryAttentionSnapshot;
}>;

export type DiscussionRepositoryAttentionSnapshot = Readonly<{
    discussions: DiscussionAttentionResultV1['discussions'];
    nextCursor: string | null;
    status: DiscussionRepositoryStatus;
    errorCode: string | null;
    incomplete: boolean;
}>;

export type DiscussionRepositoryMutationOutcome<T> =
    | Readonly<{ kind: 'succeeded'; value: T }>
    | Readonly<{ kind: 'checking' }>
    | Readonly<{ kind: 'approval_request_created'; artifactId: string }>
    | Readonly<{ kind: 'failed'; errorCode: string }>;

export type DiscussionReadStateWriteOutcome =
    | Readonly<{ kind: 'succeeded'; lastReadSeq: number }>
    | Readonly<{ kind: 'retryable'; errorCode: string }>
    | Readonly<{ kind: 'stopped'; errorCode: string }>;

const EMPTY_LIST: DiscussionRepositoryListSnapshot = Object.freeze({ items: [], nextCursor: null, status: 'idle', errorCode: null, incomplete: false });
const EMPTY_ATTENTION: DiscussionRepositoryAttentionSnapshot = Object.freeze({ discussions: [], nextCursor: null,
    status: 'idle', errorCode: null, incomplete: false });
const EMPTY_COLLECTION: DiscussionRepositoryCollectionSnapshot = Object.freeze({
    lists: Object.freeze({ active: EMPTY_LIST, archived: EMPTY_LIST }), archivedExistence: 'unknown',
});

function emptyThread(): DiscussionRepositoryThreadSnapshot {
    return { summary: null, messages: [], hasMoreOlder: false, messageSeq: 0, status: 'idle', errorCode: null, incomplete: false };
}

function stableJsonEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function retainStableRow<T extends Readonly<{ id: string }>>(current: T | undefined, incoming: T): T {
    return current && (current === incoming || stableJsonEqual(current, incoming)) ? current : incoming;
}

function flattenListPages(pages: readonly ListPage[], previous: readonly DiscussionOpenedSummaryV1[]): readonly DiscussionOpenedSummaryV1[] {
    const previousById = new Map(previous.map((row) => [row.id, row]));
    const seen = new Set<string>();
    const rows: DiscussionOpenedSummaryV1[] = [];
    for (const page of pages) {
        for (const row of page.rows) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            rows.push(retainStableRow(previousById.get(row.id), row));
        }
    }
    return rows.length === previous.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
}

export function mergeDiscussionMessages(
    previous: readonly DiscussionOpenedMessageV1[],
    incoming: readonly DiscussionOpenedMessageV1[],
): readonly DiscussionOpenedMessageV1[] {
    if (incoming.length === 0) return previous;
    const byId = new Map(previous.map((row) => [row.id, row]));
    let changed = false;
    for (const row of incoming) {
        const current = byId.get(row.id);
        const decision = current?.docEditProposalDispositionV1;
        // Decisions close once. A response captured before that commit cannot
        // reopen the proposal or restore content hidden by the settled projection.
        // Incoming null content still hides; a current terminal read can reopen it.
        const reconciled = decision && decision.state !== 'open' && row.docEditProposalDispositionV1?.state === 'open'
            ? { ...row, content: current?.content === null ? null : row.content, docEditProposalDispositionV1: decision } : row;
        const retained = retainStableRow(current, reconciled);
        if (retained !== current) { byId.set(row.id, retained); changed = true; }
    }
    return changed ? [...byId.values()].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id)) : previous;
}

function statusForFailure(errorCode: string): DiscussionRepositoryStatus {
    if (errorCode === 'offline' || errorCode === 'unavailable' || errorCode === 'canceled') return 'offline';
    if (errorCode === 'locked' || errorCode === 'discussion_encryption_mode_mismatch' || errorCode === 'discussion_content_unavailable') return 'locked';
    if (errorCode === 'forbidden' || errorCode === 'discussion_read_denied') return 'revoked';
    return 'error';
}

/** Source refusal hides retained quote material, while a transport outage preserves it. */
export function isDiscussionSourceContentRefusal(errorCode: string | null | undefined): boolean {
    return errorCode === 'discussion_content_unavailable' || errorCode === 'discussion_access_forbidden';
}

/** The detail surface's read-access projection, shared with its draft/presence eligibility. */
export function selectDiscussionThreadAccessState(snapshot: DiscussionRepositorySnapshot, discussionId: string): Readonly<{
    accessRevoked: boolean; sourceRefused: boolean;
}> {
    const thread = snapshot.threads[discussionId];
    // A current resource read can admit this thread without admitting the Home
    // list. Whole-Home access loss clears summaries; only then use its refusal.
    const useCollectionRefusal = thread?.summary == null;
    return {
        accessRevoked: thread?.status === 'revoked' || useCollectionRefusal
            && (snapshot.lists.active.status === 'revoked' || snapshot.lists.archived.status === 'revoked'),
        sourceRefused: isDiscussionSourceContentRefusal(thread?.errorCode)
            || useCollectionRefusal && (isDiscussionSourceContentRefusal(snapshot.lists.active.errorCode)
                || isDiscussionSourceContentRefusal(snapshot.lists.archived.errorCode)),
    };
}

function isExplicitAccessLoss(errorCode: string): boolean {
    return errorCode === 'forbidden'
        || errorCode === 'discussion_read_denied'
        || isDiscussionSourceContentRefusal(errorCode)
        // Protected Discussion reads intentionally collapse a missing resource and
        // lost access into the same nondisclosing result. Once private content was
        // loaded, retaining it is unsafe whichever underlying condition caused it.
        || errorCode === 'discussion_not_found';
}

/**
 * A definitive refusal will be earned again by resending the identical intent:
 * the typed domain vocabulary says the request itself, the target, or the
 * viewer's standing was refused. Everything else (offline, transport, a
 * pending E2EE key, an unknown code) keeps the identity for an explicit retry.
 */
function isDefinitiveMutationRefusal(errorCode: string): boolean {
    return errorCode === 'discussion_post_denied'
        || errorCode === 'discussion_manage_denied'
        || errorCode === 'discussion_invalid_content'
        || errorCode === 'discussion_invalid_mention'
        || errorCode === 'discussion_archived'
        || errorCode === 'discussion_encryption_mode_mismatch'
        || errorCode === 'discussion_idempotency_conflict'
        || errorCode === 'discussions_unavailable';
}

function recoveryForFailure(errorCode: string): DiscussionMutationRecovery {
    return isDefinitiveMutationRefusal(errorCode) ? 'dismiss' : 'retry';
}

function isPermanentReadStateRefusal(errorCode: string): boolean {
    return isExplicitAccessLoss(errorCode)
        || errorCode === DISCUSSION_NOT_TRACKED_CODE_V1
        || errorCode === 'discussion_read_cursor_invalid'
        || errorCode === 'discussions_unavailable';
}

export function createDiscussionRepository(options: Readonly<{
    scope: ServerAccountScope;
    address: Readonly<{ serverId: string }>;
    client: DiscussionRepositoryClient;
}>) {
    const listeners = new Set<() => void>();
    const listPages: Record<'active' | 'archived', ListPage[]> = { active: [], archived: [] };
    const anchorPages = new Map<string, { anchor: ListAnchor; pages: Record<'active' | 'archived', ListPage[]> }>();
    const retainedAnchors = () => [...anchorPages.values()].map(entry => entry.anchor);
    const listInFlight = new Map<string, Promise<void>>();
    const mountedAnchors = new Map<string, { anchor: ListAnchor; count: number }>();
    const mountedThreads = new Map<string, number>();
    const mountedSummaries = new Map<string, number>();
    const intents = new Map<string, MutationIntent>();
    let client = options.client;
    let mountedWatch: MountedDiscussionChangeWatch | null = null;
    let mountReferences = 0;
    let homeMountReferences = 0;
    let attentionMountReferences = 0;
    let attentionInFlight: Promise<void> | null = null;
    let attentionPages: DiscussionAttentionResultV1[] = [];
    let accessLossEpoch = 0;
    const resourceEpochs = new Map<string, number>();
    const captureOperation = (discussionId?: string) => ({ home: accessLossEpoch, discussionId,
        resource: discussionId === undefined ? 0 : resourceEpochs.get(discussionId) ?? 0 });
    const isCurrentOperation = (operation: ReturnType<typeof captureOperation>) => operation.home === accessLossEpoch
        && (operation.discussionId === undefined || operation.resource === (resourceEpochs.get(operation.discussionId) ?? 0));
    let snapshot: DiscussionRepositorySnapshot = {
        address: options.address,
        lists: { active: EMPTY_LIST, archived: EMPTY_LIST },
        archivedExistence: 'unknown',
        anchors: {},
        threads: {},
        mutations: {},
        attention: EMPTY_ATTENTION,
    };

    const publish = (next: DiscussionRepositorySnapshot) => {
        if (next === snapshot) return;
        snapshot = next;
        for (const listener of listeners) listener();
    };
    const purgeAccessLost = (errorCode: string) => {
        accessLossEpoch += 1;
        listInFlight.clear();
        attentionPages = [];
        listPages.active = [];
        listPages.archived = [];
        anchorPages.clear();
        intents.clear();
        const revoked: DiscussionRepositoryListSnapshot = Object.freeze({
            items: [], nextCursor: null, status: 'revoked', errorCode, incomplete: false,
        });
        publish({
            address: options.address,
            lists: { active: revoked, archived: revoked },
            archivedExistence: 'unknown',
            anchors: {},
            threads: {},
            mutations: {},
            attention: { ...EMPTY_ATTENTION, status: 'revoked', errorCode },
        });
    };
    const getListSnapshot = (anchorSessionId?: ListAnchor): DiscussionRepositoryCollectionSnapshot => anchorSessionId === undefined
        ? snapshot : snapshot.anchors[listAnchorKey(anchorSessionId)]
            ?? (snapshot.lists.active.status === 'revoked' && snapshot.lists.archived.status === 'revoked' ? snapshot : EMPTY_COLLECTION);
    const pagesFor = (anchorSessionId?: ListAnchor) => {
        if (anchorSessionId === undefined) return listPages;
        const key = listAnchorKey(anchorSessionId);
        let entry = anchorPages.get(key);
        if (!entry) { entry = { anchor: anchorSessionId, pages: { active: [], archived: [] } }; anchorPages.set(key, entry); }
        return entry.pages;
    };
    const updateCollection = (value: DiscussionRepositoryCollectionSnapshot, anchorSessionId?: ListAnchor) => publish(anchorSessionId === undefined
        ? { ...snapshot, ...value } : { ...snapshot, anchors: { ...snapshot.anchors, [listAnchorKey(anchorSessionId)]: value } });
    const updateList = (state: 'active' | 'archived', value: DiscussionRepositoryListSnapshot, anchorSessionId?: ListAnchor) => {
        const current = getListSnapshot(anchorSessionId);
        const previous = current.lists[state];
        if (previous.items === value.items && previous.nextCursor === value.nextCursor && previous.status === value.status
            && previous.errorCode === value.errorCode && previous.incomplete === value.incomplete) return;
        updateCollection({ ...current, lists: { ...current.lists, [state]: value } }, anchorSessionId);
    };
    const updateThread = (discussionId: string, value: DiscussionRepositoryThreadSnapshot) => {
        const firstMessage = value.summary?.firstMessage;
        const canonicalRoot = firstMessage && value.messages.find(row => row.id === firstMessage.id);
        const summary = canonicalRoot && canonicalRoot !== firstMessage ? { ...value.summary!, firstMessage: canonicalRoot } : value.summary;
        publish({ ...snapshot, threads: { ...snapshot.threads, [discussionId]: { ...value, summary } } });
        if (summary !== value.summary && canonicalRoot) {
            // Scoped discovery and ordinary lists retain the same summary facts;
            // an updated root must not leave a second readable body/disposition there.
            for (const anchor of [undefined, ...retainedAnchors()]) {
                const pages = pagesFor(anchor);
                for (const state of ['active', 'archived'] as const) {
                    pages[state] = pages[state].map(page => ({ ...page, rows: page.rows.map(row =>
                        row.id === discussionId && row.firstMessage ? { ...row, firstMessage: canonicalRoot } : row) }));
                    const list = getListSnapshot(anchor).lists[state];
                    applyListPages(state, list.status, list.errorCode, anchor);
                }
            }
        }
    };
    const updateMutation = (localId: string, value: DiscussionRepositoryMutation | null) => {
        const mutations = { ...snapshot.mutations };
        if (value) mutations[localId] = value;
        else delete mutations[localId];
        publish({ ...snapshot, mutations });
    };
    const markMutationObservedSuccess = (localId: string) => {
        const current = snapshot.mutations[localId];
        if (!current) return;
        const { artifactId: _artifactId, errorCode: _errorCode, recovery: _recovery, ...retained } = current;
        updateMutation(localId, { ...retained, status: 'observed_success' });
    };
    const updateArchivedExistence = (value: DiscussionArchivedExistence, anchorSessionId?: ListAnchor) => {
        const current = getListSnapshot(anchorSessionId);
        if (current.archivedExistence === value) return;
        updateCollection({ ...current, archivedExistence: value }, anchorSessionId);
    };
    const applyListPages = (state: 'active' | 'archived', status: DiscussionRepositoryStatus, errorCode: string | null, anchorSessionId?: ListAnchor) => {
        const pages = pagesFor(anchorSessionId)[state];
        const current = getListSnapshot(anchorSessionId).lists[state];
        const items = flattenListPages(pages, current.items);
        updateList(state, {
            items,
            nextCursor: pages.at(-1)?.nextCursor ?? null,
            status,
            errorCode,
            incomplete: pages.some((page) => page.incomplete),
        }, anchorSessionId);
        // Loaded archived rows are a stronger answer than the bounded probe, so
        // the list settling replaces it. A failed or still-loading read leaves
        // the last proven answer alone rather than inventing emptiness.
        if (state === 'archived' && (items.length > 0 || status === 'ready' || status === 'locked')) {
            updateArchivedExistence(items.length > 0 ? 'present' : pages.at(-1)?.nextCursor ? 'unknown' : 'empty', anchorSessionId);
        }
    };
    const purgeDiscussion = (discussionId: string, errorCode: string) => {
        resourceEpochs.set(discussionId, (resourceEpochs.get(discussionId) ?? 0) + 1);
        for (const anchor of [undefined, ...retainedAnchors()]) {
            const pages = pagesFor(anchor);
            for (const state of ['active', 'archived'] as const) {
                pages[state] = pages[state].map(page => ({ ...page, rows: page.rows.filter(row => row.id !== discussionId) }));
                const current = getListSnapshot(anchor).lists[state];
                applyListPages(state, current.status, current.errorCode, anchor);
            }
            if (pages.archived.length === 0) updateArchivedExistence('unknown', anchor);
        }
        const mutations = { ...snapshot.mutations };
        for (const [localId, mutation] of Object.entries(mutations)) {
            if (mutation.discussionId !== discussionId) continue;
            delete mutations[localId];
            intents.delete(localId);
        }
        attentionPages = attentionPages.map(page => ({ ...page, discussions: page.discussions.filter(entry => entry.discussion.id !== discussionId) }));
        publish({ ...snapshot, mutations, attention: { ...snapshot.attention,
            discussions: snapshot.attention.discussions.filter(entry => entry.discussion.id !== discussionId) }, threads: { ...snapshot.threads,
            [discussionId]: { ...emptyThread(), status: errorCode === 'discussion_content_unavailable' ? 'locked' : 'revoked', errorCode } } });
    };
    const applySummary = (incoming: DiscussionOpenedSummaryV1) => {
        const current = snapshot.threads[incoming.id];
        const firstMessage = incoming.firstMessage === undefined ? current?.summary?.firstMessage : incoming.firstMessage;
        const messages = firstMessage
            ? mergeDiscussionMessages(current?.messages ?? [], [firstMessage]) : current?.messages;
        const root = firstMessage && messages?.find(message => message.id === firstMessage.id);
        const row = root && root !== incoming.firstMessage ? { ...incoming, firstMessage: root } : incoming;
        for (const anchorSessionId of [undefined, ...retainedAnchors()]) {
            const pages = pagesFor(anchorSessionId);
            // A Doc's scoped query owns its admitted membership/projection.
            // Unscoped detail reads must not backfill it or replace its roots
            // with a broader latest-message projection. Closed membership can
            // still be removed immediately; canonical root changes reconcile
            // through updateThread below.
            if (typeof anchorSessionId === 'object' && row.archivedAt === null) continue;
            const admitted = anchorSessionId === undefined || (typeof anchorSessionId === 'string'
                ? row.anchor?.kind === 'session' && row.anchor.sessionId === anchorSessionId
                : row.anchor?.kind === 'doc' && row.anchor.doc.ref.artifactId === anchorSessionId.anchorDocArtifactId && row.archivedAt === null);
            if (!admitted && ![...pages.active, ...pages.archived].some(page => page.rows.some(item => item.id === row.id))) continue;
            const state = row.archivedAt === null ? 'active' : 'archived';
            const other = state === 'active' ? 'archived' : 'active';
            pages[other] = pages[other].map((page) => ({
                ...page,
                rows: page.rows.filter((item) => item.id !== row.id),
            }));
            let replacedExisting = false;
            pages[state] = pages[state].map((page) => ({
                ...page,
                rows: page.rows.filter(item => admitted || item.id !== row.id).map((item) => {
                    if (item.id !== row.id) return item;
                    replacedExisting = true;
                    return row;
                }),
                incomplete: page.incomplete || row.title === null,
            }));
            if (admitted && pages[state].length === 0) {
                pages[state].push({ requestCursor: null, rows: [row], nextCursor: null, incomplete: row.title === null });
            } else if (admitted && !replacedExisting) {
                const first = pages[state][0]!;
                pages[state][0] = { ...first, rows: [row, ...first.rows], incomplete: first.incomplete || row.title === null };
            }
            const current = getListSnapshot(anchorSessionId);
            applyListPages(other, current.lists[other].status, current.lists[other].errorCode, anchorSessionId);
            // A proven resource updates retained rows, not the query's freshness
            // or completeness: an unopened list must still fetch its membership.
            applyListPages(state, current.lists[state].status, current.lists[state].errorCode, anchorSessionId);
        }
        const thread = snapshot.threads[row.id];
        if (thread || row.firstMessage) updateThread(row.id, { ...(thread ?? emptyThread()), summary: row,
            ...(messages ? { messages } : {}), messageSeq: Math.max(thread?.messageSeq ?? 0, row.messageSeq) });
    };

    /** Admit scoped discovery and its opened roots under the same custody as thread reads. */
    const readList = async (input: DiscussionListInputV1, signal?: AbortSignal): Promise<DiscussionClientOutcome<DiscussionListResultV1>> => {
        const operation = captureOperation();
        const epochs = new Map(resourceEpochs);
        const outcome = await client.list(input, signal);
        if (signal?.aborted) return { kind: 'failed', errorCode: 'canceled' };
        if (!isCurrentOperation(operation)) return { kind: 'failed', errorCode: 'discussion_read_denied' };
        if (outcome.kind !== 'succeeded') {
            if (outcome.kind === 'failed' && isExplicitAccessLoss(outcome.errorCode)) purgeAccessLost(outcome.errorCode);
            return outcome;
        }
        if (outcome.value.discussions.some(row => (epochs.get(row.id) ?? 0) !== (resourceEpochs.get(row.id) ?? 0))) {
            // This response lost custody; it is not a new Home-wide refusal.
            return { kind: 'failed', errorCode: 'discussion_read_stale' };
        }
        if (outcome.value.serverId !== options.scope.serverId || outcome.value.discussions.some(row => {
            const root = row.firstMessage;
            return (input.anchorDocArtifactId !== undefined && (row.anchor?.kind !== 'doc'
                || row.anchor.doc.ref.artifactId !== input.anchorDocArtifactId || root === undefined))
                || (root && (root.seq !== 1 || root.discussionId !== row.id || root.messageRef.messageId !== root.id
                    || root.messageRef.discussion.discussionId !== row.id || root.messageRef.discussion.serverId !== options.scope.serverId));
        })) return { kind: 'failed', errorCode: 'discussion_invalid_content' };
        for (const row of outcome.value.discussions) {
            if (row.firstMessage === null) purgeDiscussion(row.id, 'discussion_content_unavailable');
            else applySummary(row);
        }
        return { kind: 'succeeded', value: { ...outcome.value,
            discussions: outcome.value.discussions.map(row => snapshot.threads[row.id]?.summary ?? row) } };
    };

    const loadListPage = async (state: 'active' | 'archived', cursor: string | null, signal?: AbortSignal, anchorSessionId?: ListAnchor) => {
        const operationEpoch = accessLossEpoch;
        const epochs = new Map(resourceEpochs);
        const input = { state, ...(cursor ? { cursor } : {}), ...listAnchorInput(anchorSessionId) };
        const docScoped = typeof anchorSessionId === 'object';
        const outcome = await (docScoped ? readList(input, signal) : client.list(input, signal));
        if (signal?.aborted) return { kind: 'failed' as const, errorCode: 'canceled' };
        if (operationEpoch !== accessLossEpoch) return { kind: 'failed' as const, errorCode: 'discussion_read_denied' };
        if (outcome.kind !== 'succeeded') return outcome;
        const rows = outcome.value.discussions.filter(row => (epochs.get(row.id) ?? 0) === (resourceEpochs.get(row.id) ?? 0));
        for (const row of rows) {
            // Query pages own membership/cursors, while a resource observed in
            // another loaded projection must not retain a divergent summary.
            if (snapshot.threads[row.id]?.summary || [listPages, ...[...anchorPages.values()].map(entry => entry.pages)].some(pages =>
                [...pages.active, ...pages.archived].some(page => page.rows.some(item => item.id === row.id)))) applySummary(row);
        }
        return { kind: 'succeeded' as const, value: {
            requestCursor: cursor,
            rows,
            nextCursor: outcome.value.nextCursor,
            // Scoped roots, not an unreadable title/latest preview, establish
            // Doc discovery. Explicit null is a known inaccessible root to
            // exclude; an unopened non-null root leaves admission unknown.
            incomplete: docScoped
                ? outcome.value.discussions.some(row => row.firstMessage === undefined
                    || (row.firstMessage !== null && row.firstMessage.content === null))
                : outcome.value.incomplete,
        } satisfies ListPage };
    };

    /**
     * One bounded archived read taken beside the active refresh, so a reader can
     * tell whether an archived Discussion exists before deciding to offer the
     * archived disclosure. It loads no page: the archived list stays lazy and
     * keeps its own pagination for when the reader actually opens it.
     */
    const probeArchivedExistence = async (signal?: AbortSignal, anchorSessionId?: ListAnchor): Promise<void> => {
        if (typeof anchorSessionId === 'object') return;
        if (pagesFor(anchorSessionId).archived.length > 0) return;
        const operationEpoch = accessLossEpoch;
        const epochs = new Map(resourceEpochs);
        const outcome = await client.list({ state: 'archived', limit: 1, ...(anchorSessionId === undefined ? {} : { anchorSessionId }) }, signal);
        if (operationEpoch !== accessLossEpoch || signal?.aborted) return;
        if (outcome.kind !== 'succeeded') {
            if (outcome.kind === 'failed' && isExplicitAccessLoss(outcome.errorCode)) purgeAccessLost(outcome.errorCode);
            return;
        }
        const visible = outcome.value.discussions.some(row => (epochs.get(row.id) ?? 0) === (resourceEpochs.get(row.id) ?? 0));
        updateArchivedExistence(visible ? 'present' : outcome.value.discussions.length > 0 ? 'unknown' : 'empty', anchorSessionId);
    };

    const listReadKey = (state: 'active' | 'archived', anchorSessionId?: ListAnchor) => JSON.stringify([anchorSessionId ?? null, state]);
    const readListPages = (state: 'active' | 'archived', append: boolean, signal?: AbortSignal, anchorSessionId?: ListAnchor,
        input: Readonly<{ complete?: boolean }> = {}): Promise<void> => {
        const key = listReadKey(state, anchorSessionId);
        const existing = listInFlight.get(key);
        if (existing) return existing;
        if (signal?.aborted) return Promise.resolve();
        const operationEpoch = accessLossEpoch;
        const epochs = new Map(resourceEpochs);
        const queryPages = pagesFor(anchorSessionId);
        const retained = getListSnapshot(anchorSessionId).lists[state];
        let cursor = append ? queryPages[state].at(-1)?.nextCursor ?? null : null;
        if (append && !cursor) return Promise.resolve();
        const pageCount = append ? 1 : Math.max(1, queryPages[state].length);
        const firstPage = loadListPage(state, cursor, undefined, anchorSessionId);
        const pending = Promise.resolve().then(async () => {
            if (operationEpoch !== accessLossEpoch) return;
            let replacement: ListPage[] = append ? [...queryPages[state]] : [];
            const visited = new Set<string | null>();
            for (let index = 0; index < pageCount || (input.complete && !signal?.aborted); index += 1) {
                if (visited.has(cursor)) {
                    updateList(state, { ...getListSnapshot(anchorSessionId).lists[state], status: 'error', errorCode: 'discussion_invalid_content' }, anchorSessionId);
                    return;
                }
                visited.add(cursor);
                // The accepted page belongs to every joined reader. Canceling
                // search demand stops further traversal, not shared page custody.
                const outcome = await (index === 0 ? firstPage : loadListPage(state, cursor, undefined, anchorSessionId));
                if (operationEpoch !== accessLossEpoch) return;
                if (outcome.kind === 'failed' && outcome.errorCode === 'canceled') {
                    const current = getListSnapshot(anchorSessionId).lists[state];
                    updateList(state, { ...current, status: input.complete && queryPages[state].length > 0
                        ? current.incomplete ? 'locked' : 'ready' : retained.status, errorCode: retained.errorCode }, anchorSessionId);
                    return;
                }
                if (outcome.kind !== 'succeeded') {
                    const code = outcome.kind === 'failed' ? outcome.errorCode : 'outcome_unknown';
                    if (isExplicitAccessLoss(code)) purgeAccessLost(code);
                    else updateList(state, { ...getListSnapshot(anchorSessionId).lists[state], status: statusForFailure(code), errorCode: outcome.kind === 'failed' ? outcome.errorCode : outcome.kind }, anchorSessionId);
                    return;
                }
                if (append) {
                    replacement = [...queryPages[state]];
                    const pageIndex = replacement.findIndex(page => page.requestCursor === cursor);
                    if (pageIndex >= 0) replacement[pageIndex] = outcome.value;
                    else replacement.push(outcome.value);
                } else replacement.push(outcome.value);
                cursor = outcome.value.nextCursor;
                if (input.complete && typeof anchorSessionId !== 'object') {
                    queryPages[state] = replacement.map(page => ({ ...page,
                        rows: page.rows.filter(row => (epochs.get(row.id) ?? 0) === (resourceEpochs.get(row.id) ?? 0)),
                    }));
                    applyListPages(state, 'loading', null, anchorSessionId);
                }
                if (!cursor) break;
            }
            queryPages[state] = replacement.map(page => ({ ...page,
                rows: page.rows.filter(row => (epochs.get(row.id) ?? 0) === (resourceEpochs.get(row.id) ?? 0)),
            }));
            applyListPages(state, replacement.some((page) => page.incomplete) ? 'locked' : 'ready', null, anchorSessionId);
            if (state === 'active' && !append && !signal?.aborted) await probeArchivedExistence(signal, anchorSessionId);
        }).finally(() => { if (listInFlight.get(key) === pending) listInFlight.delete(key); });
        listInFlight.set(key, pending);
        updateList(state, { ...retained, status: typeof anchorSessionId === 'object' && retained.status === 'ready' ? 'ready' : 'loading', errorCode: null }, anchorSessionId);
        return pending;
    };

    const refreshList = (state: 'active' | 'archived', signal?: AbortSignal, anchorSessionId?: ListAnchor,
        input?: Readonly<{ complete?: boolean }>) => readListPages(state, false, signal, anchorSessionId, input);
    const loadMoreList = (state: 'active' | 'archived', signal?: AbortSignal, anchorSessionId?: ListAnchor,
        input?: Readonly<{ complete?: boolean }>) => readListPages(state, true, signal, anchorSessionId, input);

    /** Search demand extends the same query's retained page frontier, never a second list. */
    const loadCompleteList = async (state: 'active' | 'archived', signal?: AbortSignal, anchorSessionId?: ListAnchor): Promise<void> => {
        const operationEpoch = accessLossEpoch;
        const key = listReadKey(state, anchorSessionId);
        while (listInFlight.has(key)) await listInFlight.get(key);
        if (operationEpoch !== accessLossEpoch || signal?.aborted) return;
        const current = getListSnapshot(anchorSessionId).lists[state];
        if (current.status === 'revoked') return;
        if (current.status === 'idle' || (!pagesFor(anchorSessionId)[state].length && current.status !== 'ready')
            || ((current.status === 'error' || current.status === 'offline') && !current.nextCursor)) {
            await refreshList(state, signal, anchorSessionId, { complete: true });
        } else if (current.nextCursor) await loadMoreList(state, signal, anchorSessionId, { complete: true });
    };

    const refreshMessages = async (discussionId: string, signal?: AbortSignal): Promise<void> => {
        const operationEpoch = captureOperation(discussionId);
        const retained = snapshot.threads[discussionId] ?? emptyThread();
        updateThread(discussionId, { ...retained, status: 'loading', errorCode: null });
        const messages = retained.messages;
        let messageSeq = retained.messageSeq;
        let observedHasMoreOlder: boolean | null = null;
        let oldestHistorySeq = retained.oldestHistorySeq;
        let newestHistorySeq = retained.newestHistorySeq;
        const received: DiscussionOpenedMessageV1[] = [];
        // Locked content and open proposal dispositions can change without a new
        // message sequence. Revisit their earliest retained row, even when it is
        // older than the server's default tail page.
        const firstMutableIndex = messages.findIndex((row) => row.content === null || row.docEditProposalDispositionV1?.state === 'open');
        // A scoped root or exact focused row is not a history page. First load
        // the ordinary tail, regardless of which isolated rows were opened.
        let afterSeq = oldestHistorySeq === undefined ? undefined : firstMutableIndex >= 0
            ? messages[firstMutableIndex]!.seq - 1
            : newestHistorySeq;
        for (;;) {
            const outcome = await client.read(discussionId, afterSeq === undefined ? {} : { afterSeq }, signal);
            if (!isCurrentOperation(operationEpoch)) return;
            if (outcome.kind !== 'succeeded') {
                const code = outcome.kind === 'failed' ? outcome.errorCode : outcome.kind;
                if (isExplicitAccessLoss(code)) purgeDiscussion(discussionId, code);
                else if (statusForFailure(code) === 'revoked') {
                    updateThread(discussionId, { ...emptyThread(), status: 'revoked', errorCode: code });
                } else {
                    // Reporting this read's failure must not republish the thread as it
                    // looked before the await: another surface may have loaded newer
                    // messages, and the pages this read did receive are still valid.
                    const failed = mergeDiscussionMessages(
                        (snapshot.threads[discussionId] ?? retained).messages,
                        received,
                    );
                    updateThread(discussionId, {
                        ...(snapshot.threads[discussionId] ?? retained),
                        messages: failed,
                        incomplete: failed.some((row) => row.content === null),
                        status: statusForFailure(code), errorCode: code,
                    });
                }
                return;
            }
            received.push(...outcome.value.messages);
            if (afterSeq === undefined) {
                observedHasMoreOlder = outcome.value.hasMoreOlder;
                oldestHistorySeq = outcome.value.messages[0]?.seq;
            }
            messageSeq = Math.max(messageSeq, outcome.value.messageSeq);
            const highest = outcome.value.messages.reduce((highest, row) => Math.max(highest, row.seq), afterSeq ?? 0);
            if (outcome.value.messages.length > 0) newestHistorySeq = Math.max(newestHistorySeq ?? 0, highest);
            if (highest >= messageSeq
                || outcome.value.messages.length === 0
                || (afterSeq !== undefined && highest <= afterSeq)) {
                break;
            }
            afterSeq = highest;
        }
        // Another mounted surface can publish newer rows while this read is in
        // flight, so the response reconciles against the current thread instead of
        // the snapshot it captured before awaiting.
        const current = snapshot.threads[discussionId] ?? retained;
        const merged = mergeDiscussionMessages(current.messages, received);
        const incomplete = merged.some((row) => row.content === null);
        updateThread(discussionId, {
            ...current,
            messages: merged,
            hasMoreOlder: observedHasMoreOlder ?? current.hasMoreOlder,
            oldestHistorySeq: current.oldestHistorySeq === undefined ? oldestHistorySeq
                : Math.min(current.oldestHistorySeq, oldestHistorySeq ?? current.oldestHistorySeq),
            newestHistorySeq: newestHistorySeq === undefined ? current.newestHistorySeq
                : Math.max(current.newestHistorySeq ?? 0, newestHistorySeq),
            messageSeq: Math.max(current.messageSeq, messageSeq),
            status: incomplete ? 'locked' : 'ready',
            errorCode: null,
            incomplete,
        });
        for (const intent of intents.values()) {
            if (intent.kind === 'post'
                && intent.discussionId === discussionId
                && merged.some((row) => row.localId === intent.localId)) {
                markMutationObservedSuccess(intent.localId);
            }
        }
    };

    const refreshSummary = async (discussionId: string, signal?: AbortSignal): Promise<boolean> => {
        const operationEpoch = captureOperation(discussionId);
        const retained = snapshot.threads[discussionId] ?? emptyThread();
        const outcome = await client.get(discussionId, signal);
        if (!isCurrentOperation(operationEpoch)) return false;
        if (outcome.kind !== 'succeeded') {
            const code = outcome.kind === 'failed' ? outcome.errorCode : outcome.kind;
            if (isExplicitAccessLoss(code)) purgeDiscussion(discussionId, code);
            else updateThread(discussionId, {
                ...(statusForFailure(code) === 'revoked' ? emptyThread() : retained),
                status: statusForFailure(code), errorCode: code,
            });
            return false;
        }
        applySummary(outcome.value.discussion);
        // `applySummary` only refreshes a thread that already exists. A reader opening
        // an existing Discussion for the first time in this repository lifetime has no
        // thread yet, so the summary this get just proved must seed it; otherwise the
        // following message read creates an empty thread and the Discussion renders
        // unavailable after a successful load. Other summary producers (list rows,
        // lifecycle results) deliberately do not create threads.
        if (!snapshot.threads[discussionId]) {
            updateThread(discussionId, { ...emptyThread(), summary: outcome.value.discussion });
        }
        return true;
    };

    const refreshDiscussion = async (discussionId: string, signal?: AbortSignal): Promise<void> => {
        if (!await refreshSummary(discussionId, signal)) return;
        await refreshMessages(discussionId, signal);
    };

    const loadOlderMessages = async (discussionId: string, signal?: AbortSignal): Promise<void> => {
        const retained = snapshot.threads[discussionId] ?? emptyThread();
        const operationEpoch = captureOperation(discussionId);
        const beforeSeq = retained.oldestHistorySeq;
        if (beforeSeq === undefined || !retained.hasMoreOlder) return;
        updateThread(discussionId, { ...retained, status: 'loading', errorCode: null });
        const outcome = await client.read(discussionId, { beforeSeq }, signal);
        if (!isCurrentOperation(operationEpoch)) return;
        if (outcome.kind !== 'succeeded') {
            const code = outcome.kind === 'failed' ? outcome.errorCode : outcome.kind;
            if (isExplicitAccessLoss(code)) purgeDiscussion(discussionId, code);
            else updateThread(discussionId, {
                ...(snapshot.threads[discussionId] ?? retained),
                status: statusForFailure(code),
                errorCode: code,
            });
            return;
        }
        const current = snapshot.threads[discussionId] ?? retained;
        const merged = mergeDiscussionMessages(current.messages, outcome.value.messages);
        const incomplete = merged.some((row) => row.content === null);
        updateThread(discussionId, {
            ...current,
            messages: merged,
            hasMoreOlder: outcome.value.hasMoreOlder,
            oldestHistorySeq: Math.min(current.oldestHistorySeq ?? beforeSeq, outcome.value.messages[0]?.seq ?? beforeSeq),
            messageSeq: Math.max(current.messageSeq, outcome.value.messageSeq),
            status: incomplete ? 'locked' : 'ready',
            errorCode: null,
            incomplete,
        });
    };

    const recordMutation = (intent: MutationIntent, status: DiscussionMutationStatus, detail?: Readonly<{ artifactId?: string; errorCode?: string; recovery?: DiscussionMutationRecovery }>) => {
        const localId = intent.kind === 'create' ? intent.creationLocalId : intent.localId;
        intents.set(localId, intent);
        updateMutation(localId, {
            kind: intent.kind, localId,
            ...(intent.kind === 'create' ? { messageLocalId: intent.messageLocalId } : { discussionId: intent.discussionId }),
            status,
            content: intent.content,
            ...(intent.mentionedAccountIds ? { mentionedAccountIds: intent.mentionedAccountIds } : {}),
            ...(intent.mentionedSessionIds ? { mentionedSessionIds: intent.mentionedSessionIds } : {}),
            draftSubmission: intent.draftSubmission,
            ...detail,
        });
    };

    const completeCreate = (intent: CreateIntent, value: DiscussionCreateResultV1) => {
        applySummary(value.discussion);
        const retained = snapshot.threads[value.discussion.id] ?? emptyThread();
        updateThread(value.discussion.id, {
            ...retained,
            summary: value.discussion,
            messages: mergeDiscussionMessages(retained.messages, [value.firstMessage]),
            messageSeq: value.discussion.messageSeq,
            hasMoreOlder: retained.messages.length > 0 ? retained.hasMoreOlder : false,
            status: value.firstMessage.content === null ? 'locked' : 'ready',
            errorCode: null,
            incomplete: retained.incomplete || value.firstMessage.content === null,
        });
        const mutation = snapshot.mutations[intent.creationLocalId];
        if (mutation) updateMutation(intent.creationLocalId, { ...mutation, discussionId: value.discussion.id });
        markMutationObservedSuccess(intent.creationLocalId);
    };

    const completePost = (intent: PostIntent, value: DiscussionPostResultV1) => {
        const retained = snapshot.threads[intent.discussionId] ?? emptyThread();
        updateThread(intent.discussionId, {
            ...retained,
            messages: mergeDiscussionMessages(retained.messages, [value.message]),
            messageSeq: value.messageSeq,
            status: value.message.content === null ? 'locked' : 'ready',
            errorCode: null,
            incomplete: retained.incomplete || value.message.content === null,
        });
        markMutationObservedSuccess(intent.localId);
    };

    const findCreatedDiscussionInList = async (
        intent: CreateIntent,
        state: 'active' | 'archived',
        operationEpoch: number,
        signal?: AbortSignal,
    ): Promise<
        | { kind: 'found'; row: DiscussionOpenedSummaryV1 }
        | { kind: 'absent' }
        | { kind: 'unavailable' }
    > => {
        let cursor: string | null = null;
        const visitedCursors = new Set<string>();
        for (;;) {
            const outcome = await client.list({ state, creationLocalId: intent.creationLocalId, ...(cursor ? { cursor } : {}) }, signal);
            if (operationEpoch !== accessLossEpoch) return { kind: 'unavailable' };
            if (outcome.kind !== 'succeeded') {
                return { kind: 'unavailable' };
            }
            const found = outcome.value.discussions.find((row) => row.creationLocalId === intent.creationLocalId);
            if (found) return { kind: 'found', row: found };
            const nextCursor = outcome.value.nextCursor;
            if (!nextCursor || visitedCursors.has(nextCursor)) return { kind: 'absent' };
            visitedCursors.add(nextCursor);
            cursor = nextCursor;
        }
    };

    const reconcileCreate = async (intent: CreateIntent, signal?: AbortSignal): Promise<boolean> => {
        const operationEpoch = accessLossEpoch;
        // A create can commit and then be archived — by this Account elsewhere
        // or by another collaborator — before the one-shot reconciler runs.
        // Observing only the active projection reports a committed discussion
        // as never created and leaves the attempt open for a duplicate resend,
        // so both existing list projections are observed before concluding
        // absence. Neither adds a route: this is the same paged list owner.
        let found: DiscussionOpenedSummaryV1 | null = null;
        for (const state of ['active', 'archived'] as const) {
            const outcome = await findCreatedDiscussionInList(intent, state, operationEpoch, signal);
            if (outcome.kind === 'unavailable') return false;
            if (outcome.kind === 'found') {
                found = outcome.row;
                break;
            }
        }
        if (!found) return false;
        // Resource/message existence cannot prove the post-create key-delivery
        // step completed. An explicit retry reuses this intent and the original
        // authorized envelope through the same create Action and shared runner.
        if (found.encryptionMode === 'e2ee' && intent.participants?.some(participant => participant.kind === 'account')) return false;
        const resourceOperation = captureOperation(found.id);
        const messages = await client.read(found.id, { localId: intent.messageLocalId }, signal);
        if (operationEpoch !== accessLossEpoch || !isCurrentOperation(resourceOperation)) return false;
        if (messages.kind !== 'succeeded') {
            if (messages.kind === 'failed' && isExplicitAccessLoss(messages.errorCode)) {
                purgeDiscussion(found.id, messages.errorCode);
                intents.delete(intent.creationLocalId);
                updateMutation(intent.creationLocalId, null);
            }
            return false;
        }
        const firstMessage = messages.value.messages.find((row) => row.localId === intent.messageLocalId);
        if (!firstMessage) return false;
        completeCreate(intent, {
            v: 1,
            serverId: options.address.serverId,
            discussion: found,
            firstMessage,
        });
        return true;
    };

    const reconcilePost = async (intent: PostIntent, signal?: AbortSignal): Promise<boolean> => {
        const operationEpoch = captureOperation(intent.discussionId);
        const retained = snapshot.threads[intent.discussionId] ?? emptyThread();
        const alreadyPublished = retained.messages.find((row) => row.localId === intent.localId);
        if (alreadyPublished) {
            completePost(intent, {
                v: 1,
                serverId: options.address.serverId,
                message: alreadyPublished,
                messageSeq: retained.messageSeq,
            });
            return true;
        }
        const outcome = await client.read(intent.discussionId, { localId: intent.localId }, signal);
        if (!isCurrentOperation(operationEpoch)) return false;
        if (outcome.kind !== 'succeeded') {
            if (outcome.kind === 'failed' && isExplicitAccessLoss(outcome.errorCode)) purgeDiscussion(intent.discussionId, outcome.errorCode);
            return false;
        }
        const found = outcome.value.messages.find((row) => row.localId === intent.localId);
        if (!found) return false;
        completePost(intent, { v: 1, serverId: options.address.serverId, message: found, messageSeq: outcome.value.messageSeq });
        return true;
    };

    const reconcileIntent = async (intent: MutationIntent, signal?: AbortSignal): Promise<boolean> => (
        intent.kind === 'create'
            ? await reconcileCreate(intent, signal)
            : await reconcilePost(intent, signal)
    );

    const reconcileRecordedIntent = async (intent: MutationIntent, signal?: AbortSignal): Promise<boolean> => {
        const localId = intent.kind === 'create' ? intent.creationLocalId : intent.localId;
        let observed = false;
        try {
            observed = await reconcileIntent(intent, signal);
        } catch {
            observed = false;
        }
        if (observed) return true;

        const retained = snapshot.mutations[localId];
        if (retained?.status === 'checking' || retained?.status === 'outcome_unknown') {
            recordMutation(intent, 'outcome_unknown', { errorCode: 'outcome_unknown' });
        }
        return false;
    };

    const executeCreate = async (initialIntent: CreateIntent, signal?: AbortSignal): Promise<DiscussionRepositoryMutationOutcome<DiscussionCreateResultV1>> => {
        let intent = initialIntent;
        const operationEpoch = accessLossEpoch;
        recordMutation(intent, 'sending');
        const outcome = await client.create({ ...intent, onResolvedParticipants: participants => {
            // The front door owns resolution. Retain its concrete choice in the
            // existing mutation intent before approval or an uncertain write.
            if (operationEpoch !== accessLossEpoch) return;
            intent = { ...intent, participants: [...participants] };
            intents.set(intent.creationLocalId, intent);
        } }, signal);
        if (operationEpoch !== accessLossEpoch) return { kind: 'failed', errorCode: 'discussion_read_denied' };
        if (outcome.kind === 'succeeded') {
            completeCreate(intent, outcome.value);
            return outcome;
        }
        if (outcome.kind === 'approval_request_created') {
            recordMutation(intent, 'approval_pending', { artifactId: outcome.artifactId });
            return { kind: 'approval_request_created', artifactId: outcome.artifactId };
        }
        if (outcome.errorCode === 'outcome_unknown') {
            recordMutation(intent, 'checking');
            void reconcileRecordedIntent(intent, signal);
            return { kind: 'checking' };
        }
        // This proposed resource/participant set can be refused without losing
        // Account-wide access. Home retirement belongs to the lifetime owner.
        recordMutation(intent, 'failed', { errorCode: outcome.errorCode, recovery: recoveryForFailure(outcome.errorCode) });
        return outcome;
    };

    const executePost = async (intent: PostIntent, signal?: AbortSignal): Promise<DiscussionRepositoryMutationOutcome<DiscussionPostResultV1>> => {
        const operationEpoch = captureOperation(intent.discussionId);
        recordMutation(intent, 'sending');
        const outcome = await client.post(intent, signal);
        if (!isCurrentOperation(operationEpoch)) return { kind: 'failed', errorCode: 'discussion_read_denied' };
        if (outcome.kind === 'succeeded') {
            completePost(intent, outcome.value);
            return outcome;
        }
        if (outcome.kind === 'approval_request_created') {
            recordMutation(intent, 'approval_pending', { artifactId: outcome.artifactId });
            return { kind: 'approval_request_created', artifactId: outcome.artifactId };
        }
        if (outcome.errorCode === 'outcome_unknown') {
            recordMutation(intent, 'checking');
            void reconcileRecordedIntent(intent, signal);
            return { kind: 'checking' };
        }
        if (isExplicitAccessLoss(outcome.errorCode)) purgeDiscussion(intent.discussionId, outcome.errorCode);
        else recordMutation(intent, 'failed', { errorCode: outcome.errorCode, recovery: recoveryForFailure(outcome.errorCode) });
        return outcome;
    };

    const retry = async (localId: string, signal?: AbortSignal): Promise<DiscussionRepositoryMutationOutcome<DiscussionCreateResultV1 | DiscussionPostResultV1>> => {
        const intent = intents.get(localId);
        if (!intent) return { kind: 'failed', errorCode: 'discussion_retry_not_found' };
        return intent.kind === 'create' ? executeCreate(intent, signal) : executePost(intent, signal);
    };

    const adoptPendingIntent = (intent: MutationIntent, signal?: AbortSignal): void => {
        const localId = intent.kind === 'create' ? intent.creationLocalId : intent.localId;
        if (intents.has(localId)) return;
        recordMutation(intent, 'checking');
        void reconcileRecordedIntent(intent, signal);
    };

    const applyLifecycleOutcome = (discussionId: string, outcome: DiscussionClientOutcome<DiscussionDetailsResultV1>, operationEpoch: ReturnType<typeof captureOperation>) => {
        if (!isCurrentOperation(operationEpoch)) return { kind: 'failed' as const, errorCode: 'discussion_read_denied' };
        if (outcome.kind === 'succeeded') applySummary(outcome.value.discussion);
        else if (outcome.kind === 'failed' && isExplicitAccessLoss(outcome.errorCode)) purgeDiscussion(discussionId, outcome.errorCode);
        return outcome;
    };

    const applyAccessOutcome = async <TOutcome extends DiscussionClientOutcome<unknown>
        | Readonly<{ kind: 'checking'; value?: unknown }>>(discussionId: string,
        operation: () => Promise<TOutcome>, signal?: AbortSignal, refresh = true): Promise<TOutcome | Readonly<{ kind: 'failed'; errorCode: string }>> => {
        const epoch = captureOperation(discussionId);
        const outcome = await operation();
        if (!isCurrentOperation(epoch)) return { kind: 'failed', errorCode: 'discussion_read_denied' };
        if ((outcome.kind === 'succeeded' || outcome.kind === 'checking') && outcome.value !== undefined) {
            if (outcome.value !== null && typeof outcome.value === 'object' && 'access' in outcome.value
                && outcome.value.access === null) purgeDiscussion(discussionId, 'discussion_read_denied');
            else if (refresh) {
                await refreshDiscussion(discussionId, signal);
                if (!isCurrentOperation(epoch)) return { kind: 'failed', errorCode: 'discussion_read_denied' };
            }
        } else if (outcome.kind === 'failed' && isExplicitAccessLoss(outcome.errorCode)) purgeDiscussion(discussionId, outcome.errorCode);
        return outcome;
    };

    const refreshLoaded = async (discussionIds: readonly string[]): Promise<void> => {
        const work: Promise<void>[] = [];
        if (attentionMountReferences > 0) work.push(refreshAttentionAfterChange());
        for (const anchor of [...(homeMountReferences > 0 ? [undefined] : []), ...[...mountedAnchors.values()].map(entry => entry.anchor)]) {
            const reread = async (state: 'active' | 'archived') => {
                const epoch = accessLossEpoch;
                const pending = listInFlight.get(listReadKey(state, anchor));
                if (pending) await pending;
                if (epoch === accessLossEpoch) await refreshList(state, undefined, anchor, { complete: typeof anchor === 'object' });
            };
            work.push(reread('active'));
            if (pagesFor(anchor).archived.length > 0) work.push(reread('archived'));
        }
        for (const discussionId of discussionIds) {
            if (mountedThreads.has(discussionId)) work.push(refreshDiscussion(discussionId));
            else if (snapshot.threads[discussionId] || mountedSummaries.has(discussionId)) {
                // A changed retained resource still rechecks current access and
                // withdraws revoked content. A list/title is not message demand.
                work.push((async () => { await refreshSummary(discussionId); })());
            }
        }
        await Promise.all(work);
        await Promise.all([...intents.values()].map(async (intent) => {
            const localId = intent.kind === 'create' ? intent.creationLocalId : intent.localId;
            const status = snapshot.mutations[localId]?.status;
            if (status === 'checking' || status === 'outcome_unknown' || status === 'approval_pending') {
                await reconcileRecordedIntent(intent);
            }
        }));
    };

    const readAttentionPages = async (append: boolean, signal?: AbortSignal): Promise<void> => {
        const operation = captureOperation();
        const previous = snapshot.attention;
        publish({ ...snapshot, attention: { ...previous, status: 'loading', errorCode: null } });
        const pages = append ? [...attentionPages] : [];
        const pageCount = append ? 1 : Math.max(1, attentionPages.length);
        let cursor = append ? previous.nextCursor : null;
        for (let index = 0; index < pageCount; index += 1) {
            const outcome = await client.attention(cursor ? { cursor } : {}, signal);
            if (!isCurrentOperation(operation)) return;
            if (signal?.aborted || (outcome.kind === 'failed' && outcome.errorCode === 'canceled')) {
                publish({ ...snapshot, attention: previous });
                return;
            }
            if (outcome.kind !== 'succeeded' || outcome.value.serverId !== options.scope.serverId) {
                const code = outcome.kind === 'failed' ? outcome.errorCode : 'discussion_invalid_content';
                if (isExplicitAccessLoss(code)) purgeAccessLost(code);
                else publish({ ...snapshot, attention: { ...snapshot.attention, status: statusForFailure(code), errorCode: code } });
                return;
            }
            pages.push(outcome.value);
            cursor = outcome.value.nextCursor;
            if (!cursor) break;
        }
        const byDiscussion = new Map<string, DiscussionAttentionResultV1['discussions'][number]>();
        for (const page of pages) for (const entry of page.discussions) {
            const current = byDiscussion.get(entry.discussion.id);
            byDiscussion.set(entry.discussion.id, current ? { ...entry, occurrences: [...current.occurrences, ...entry.occurrences] } : entry);
        }
        const discussions = [...byDiscussion.values()];
        attentionPages = pages;
        const stable = stableJsonEqual(snapshot.attention.discussions, discussions) ? snapshot.attention.discussions : discussions;
        publish({ ...snapshot, attention: { discussions: stable, nextCursor: cursor,
            incomplete: pages.some(page => page.incomplete), status: 'ready', errorCode: null } });
    };
    const refreshAttention = (signal?: AbortSignal): Promise<void> => {
        if (attentionInFlight) return attentionInFlight;
        const pending = readAttentionPages(false, signal).finally(() => { if (attentionInFlight === pending) attentionInFlight = null; });
        attentionInFlight = pending;
        return pending;
    };
    // A change may commit after a pending HTTP read took its snapshot. Share
    // demanded reads, but reread after that snapshot before settling a change.
    const refreshAttentionAfterChange = async (signal?: AbortSignal): Promise<void> => {
        const operation = captureOperation();
        if (attentionInFlight) await attentionInFlight;
        if (isCurrentOperation(operation)) await refreshAttention(signal);
    };

    return {
        scope: options.scope,
        getSnapshot: () => snapshot,
        getListSnapshot,
        getDocListSnapshot: (artifactId: string) => getListSnapshot({ anchorDocArtifactId: artifactId }).lists.active,
        subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
        setClient(nextClient: DiscussionRepositoryClient) { client = nextClient; },
        refreshList,
        refreshDocList: (artifactId: string, signal?: AbortSignal) => refreshList('active', signal, { anchorDocArtifactId: artifactId }, { complete: true }),
        readList,
        refreshAttention,
        async loadMoreAttention(signal?: AbortSignal) {
            while (attentionInFlight) await attentionInFlight;
            if (!snapshot.attention.nextCursor) return;
            const pending = readAttentionPages(true, signal).finally(() => { if (attentionInFlight === pending) attentionInFlight = null; });
            attentionInFlight = pending;
            return pending;
        },
        loadMoreList,
        loadCompleteList,
        refreshSummary,
        refreshAnchoredList(anchorSessionId: string, state: 'active' | 'archived', signal?: AbortSignal) { return refreshList(state, signal, anchorSessionId); },
        loadMoreAnchoredList(anchorSessionId: string, state: 'active' | 'archived', signal?: AbortSignal) { return loadMoreList(state, signal, anchorSessionId); },
        refreshDiscussion,
        /** Reopen one committed message in its own Home without acquiring unrelated history. */
        async openMessage(ref: DiscussionMessageRefV1, signal?: AbortSignal): Promise<DiscussionOpenedMessageV1 | null> {
            if (ref.discussion.serverId !== options.address.serverId) return null;
            const discussionId = ref.discussion.discussionId;
            if (!await refreshSummary(discussionId, signal)) return null;
            const operationEpoch = captureOperation(discussionId);
            const outcome = await client.read(discussionId, { messageId: ref.messageId }, signal);
            if (!isCurrentOperation(operationEpoch)) return null;
            const current = snapshot.threads[discussionId] ?? emptyThread();
            if (outcome.kind !== 'succeeded') {
                const code = outcome.kind === 'failed' ? outcome.errorCode : outcome.kind;
                if (isExplicitAccessLoss(code)) purgeDiscussion(discussionId, code);
                else updateThread(discussionId, { ...current, status: statusForFailure(code), errorCode: code });
                return null;
            }
            const messages = mergeDiscussionMessages(current.messages, outcome.value.messages);
            const incomplete = messages.some(row => row.content === null);
            updateThread(discussionId, { ...current, messages, messageSeq: Math.max(current.messageSeq, outcome.value.messageSeq),
                status: incomplete ? 'locked' : 'ready', errorCode: null, incomplete });
            return outcome.value.messages.some(row => row.id === ref.messageId)
                ? messages.find(row => row.id === ref.messageId && row.content !== null) ?? null : null;
        },
        refreshMessages,
        loadOlderMessages,
        create(input: Omit<CreateIntent, 'kind'>, signal?: AbortSignal) { return executeCreate({ kind: 'create', ...input }, signal); },
        post(input: Omit<PostIntent, 'kind'>, signal?: AbortSignal) { return executePost({ kind: 'post', ...input }, signal); },
        retry,
        adoptPendingIntent,
        acknowledgeObservedSuccess(localId: string) {
            if (snapshot.mutations[localId]?.status !== 'observed_success') return false;
            updateMutation(localId, null);
            intents.delete(localId);
            return true;
        },
        /**
         * Drops a settled failure together with its retry identity. The V2
         * draft owner still holds the text, so the next send is a fresh
         * attempt under a new local id rather than a repeat of the refused one.
         */
        dismissFailure(localId: string) {
            if (snapshot.mutations[localId]?.status !== 'failed') return false;
            updateMutation(localId, null);
            intents.delete(localId);
            return true;
        },
        async rename(discussionId: string, title: string, signal?: AbortSignal) {
            const operationEpoch = captureOperation(discussionId);
            return applyLifecycleOutcome(discussionId, await client.rename(discussionId, title, signal), operationEpoch);
        },
        async archive(discussionId: string, signal?: AbortSignal) {
            const operationEpoch = captureOperation(discussionId);
            return applyLifecycleOutcome(discussionId, await client.archive(discussionId, signal), operationEpoch);
        },
        async restore(discussionId: string, signal?: AbortSignal) {
            const operationEpoch = captureOperation(discussionId);
            return applyLifecycleOutcome(discussionId, await client.restore(discussionId, signal), operationEpoch);
        },
        participants: (discussionId: string, signal?: AbortSignal) => applyAccessOutcome(discussionId, () => client.participants(discussionId, signal), signal, false),
        getSettings: (discussionId: string, signal?: AbortSignal) => applyAccessOutcome(discussionId, () => client.getSettings(discussionId, signal), signal, false),
        setSettings: (discussionId: string, settings: Parameters<DiscussionRepositoryClient['setSettings']>[1], signal?: AbortSignal) => applyAccessOutcome(discussionId, () => client.setSettings(discussionId, settings, signal), signal, false),
        setParticipantPolicy: (input: Parameters<DiscussionRepositoryClient['setParticipantPolicy']>[0], signal?: AbortSignal) => applyAccessOutcome(input.discussionId, () => client.setParticipantPolicy(input, signal), signal),
        listGrants: (discussionId: string, signal?: AbortSignal) => applyAccessOutcome(discussionId, () => client.listGrants(discussionId, signal), signal, false),
        invite: (input: Parameters<DiscussionRepositoryClient['invite']>[0], signal?: AbortSignal) => applyAccessOutcome(input.discussionId, () => client.invite(input, signal), signal),
        inviteExecutableParticipant: (input: Parameters<DiscussionRepositoryClient['inviteExecutableParticipant']>[0], signal?: AbortSignal) => applyAccessOutcome(input.discussionId, () => client.inviteExecutableParticipant(input, signal), signal),
        removeParticipant: (input: Parameters<DiscussionRepositoryClient['removeParticipant']>[0], signal?: AbortSignal) => applyAccessOutcome(input.discussionId, () => client.removeParticipant(input, signal), signal),
        leave: (discussionId: string, signal?: AbortSignal) => applyAccessOutcome(discussionId, () => client.leave(discussionId, signal), signal),
        transferOwner: (input: Parameters<DiscussionRepositoryClient['transferOwner']>[0], signal?: AbortSignal) => applyAccessOutcome(input.discussionId, () => client.transferOwner(input, signal), signal),
        setGrant: (input: Parameters<DiscussionRepositoryClient['setGrant']>[0], signal?: AbortSignal) => applyAccessOutcome(input.discussionId, () => client.setGrant(input, signal), signal),
        removeGrant: (input: Parameters<DiscussionRepositoryClient['removeGrant']>[0], signal?: AbortSignal) => applyAccessOutcome(input.discussionId, () => client.removeGrant(input, signal), signal),
        async setReadState(discussionId: string, lastReadSeq: number, signal?: AbortSignal): Promise<DiscussionReadStateWriteOutcome> {
            const operationEpoch = captureOperation(discussionId);
            const outcome = await client.readState(discussionId, lastReadSeq, signal);
            if (!isCurrentOperation(operationEpoch)) {
                return { kind: 'stopped', errorCode: 'discussion_read_denied' };
            }
            if (outcome.kind === 'succeeded') {
                if (attentionMountReferences > 0) await refreshAttentionAfterChange(signal);
                return { kind: 'succeeded', lastReadSeq: outcome.value.cursor.lastReadSeq };
            }
            if (outcome.kind === 'approval_request_created') {
                return { kind: 'stopped', errorCode: 'approval_request_created' };
            }
            if (isExplicitAccessLoss(outcome.errorCode)) purgeDiscussion(discussionId, outcome.errorCode);
            return isPermanentReadStateRefusal(outcome.errorCode)
                ? { kind: 'stopped', errorCode: outcome.errorCode }
                : { kind: 'retryable', errorCode: outcome.errorCode };
        },
        mount(input?: Readonly<{ anchorSessionId?: string; anchorDocArtifactId?: string; discussionId?: string; projection?: 'summary'; attention?: boolean }>) {
            mountReferences += 1;
            const anchor: ListAnchor | undefined = input?.anchorDocArtifactId === undefined ? input?.anchorSessionId : { anchorDocArtifactId: input.anchorDocArtifactId };
            const threadId = input?.discussionId;
            const threadMounts = input?.projection === 'summary' ? mountedSummaries : mountedThreads;
            if (input?.attention) attentionMountReferences += 1;
            else if (threadId !== undefined) threadMounts.set(threadId, (threadMounts.get(threadId) ?? 0) + 1);
            else if (anchor === undefined) homeMountReferences += 1;
            else { const key = listAnchorKey(anchor); mountedAnchors.set(key, { anchor, count: (mountedAnchors.get(key)?.count ?? 0) + 1 }); }
            if (!mountedWatch) {
                mountedWatch = watchMountedDiscussions({ scope: options.scope, address: options.address,
                    includeDocSourceChanges: () => attentionMountReferences > 0 || [...mountedAnchors.values()].some(entry => typeof entry.anchor === 'object'),
                    onInvalidated: discussionIds => { void refreshLoaded(discussionIds); } });
            }
            let released = false;
            return () => {
                if (released) return;
                released = true;
                mountReferences -= 1;
                if (input?.attention) attentionMountReferences -= 1;
                else if (threadId !== undefined) {
                    const remaining = (threadMounts.get(threadId) ?? 1) - 1;
                    if (remaining > 0) threadMounts.set(threadId, remaining);
                    else threadMounts.delete(threadId);
                }
                else if (anchor === undefined) homeMountReferences -= 1;
                else {
                    const key = listAnchorKey(anchor);
                    const remaining = (mountedAnchors.get(key)?.count ?? 1) - 1;
                    if (remaining > 0) mountedAnchors.set(key, { anchor, count: remaining });
                    else mountedAnchors.delete(key);
                }
                if (mountReferences === 0) {
                    mountedWatch?.dispose();
                    mountedWatch = null;
                }
            };
        },
        isMounted: () => mountReferences > 0,
        clear() {
            accessLossEpoch += 1;
            mountedWatch?.dispose();
            mountedWatch = null;
            mountReferences = 0;
            homeMountReferences = 0;
            attentionMountReferences = 0;
            attentionPages = [];
            attentionInFlight = null;
            listInFlight.clear();
            mountedAnchors.clear();
            mountedThreads.clear();
            mountedSummaries.clear();
            listPages.active = [];
            listPages.archived = [];
            anchorPages.clear();
            resourceEpochs.clear();
            intents.clear();
            publish({ address: options.address, lists: { active: EMPTY_LIST, archived: EMPTY_LIST }, archivedExistence: 'unknown',
                attention: EMPTY_ATTENTION, anchors: {}, threads: {}, mutations: {} });
        },
    };
}

export type DiscussionRepository = ReturnType<typeof createDiscussionRepository>;
