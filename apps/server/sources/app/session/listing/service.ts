import type { SessionListQueryResponseV1 } from '@happier-dev/protocol/sessions/listing/response';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import type { V2SessionListCursorV2, V2SessionListResponse } from '@happier-dev/protocol/sessions/control/contract';
import { SESSION_LIST_PAGE_DEFAULT_LIMIT } from '@happier-dev/protocol/sessions/listing/query';
import { SessionListQueryResponseV1Schema, SessionRuntimeManagedSubtreeListResponseV1Schema,
    type SessionRuntimeManagedSubtreeListResponseV1 } from '@happier-dev/protocol/sessions/listing/response';
import type { Prisma } from "@prisma/client";
import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { readSnapshotWithCurrentAdmission } from "@/storage/readSnapshotWithCurrentAdmission";
import { readmitSessionRowsInTx } from "@/app/session/access/sessionReadAdmission";
import { fetchSessionOrganizationPinnedSessionIds } from "@/app/session/organization/organizationQueries";
import { buildSessionAccessWhere, createApplicableAudienceWhere, resolveEffectiveSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import { isSessionCollaborationEnabled } from "@/app/session/access/sessionAccess";
import { hasSessionTranscriptPublicationLiveFacts } from "@/app/session/sessionTranscriptPublicationPolicy";
import {
    createSessionPersonalAttentionQueryInTx,
    createSessionListScopeWhere,
} from "@/app/session/personal/queries";
import type { SessionPersonalDiscussionFacts } from "@/app/session/personal/discussionFacts";
import { loadSessionLatestFailureSequencesInTx } from "@/app/session/personal/projection";
import {
    readSessionMetadataOwnerAccountModes,
    isSessionMetadataPrivacyUpgradeRequiredError,
    requiresSessionMetadataOwnerAccountMode,
    type SessionMetadataOwnerAccountMode,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import {
    createV2SessionListRowPage,
    findV2SessionListRows,
    mapV2SessionListRows,
    readSessionListOtherNamedCollaboratorFacts,
    readSessionListViewerDiscussionFacts,
    resolveV2SessionListCursorForVisibleRows,
    type SessionListReadSource,
    type SessionListRowAdmission,
    V2_ACTIVE_SESSION_LIST_ORDER_BY,
    V2_ACTIVE_SESSION_LIST_ROW_LIMIT,
    V2_SESSION_LIST_ORDER_BY,
} from "./page";
import { createV2SessionAttentionPage, createV2SessionListInitialPage } from "./initialPage";
import {
    conjoinSessionListWhereInputs,
    createFilteredSessionListWhere,
    createLegacyActiveSessionListWhere,
    createSessionListStorageWhere,
    createSessionViewerTagWhere,
} from "./query";
import type { createV2SessionListServerTiming } from "./timing";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { readSessionManagedSubtreeSessionIdsInTx } from "@/app/session/follow/sessionManagerSubtree";
import { projectSessionManagerForRowsInTx, readmitCapturedSessionManagerReferencesInTx, type SessionManagerContribution } from "@/app/session/awareness/sessionManagerProjection";
import { readAccountFollowRuleReceiverCountsInTx } from '@/app/session/follow/accountFollowRuleService';
import { deriveSessionCoordinatorV1 } from '@happier-dev/protocol/sessions/follow/sessionCoordinatorV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { mapV2SessionListRow } from './rows';
import { projectSessionEffectiveAccessV1, type EffectiveSessionAccess } from '@/app/session/access/sessionAccess';

export class SessionListCredentialScopeDeniedError extends Error {
    readonly code = 'credential_scope_denied';
    constructor() { super('credential_scope_denied'); }
}

export class SessionListInvalidCursorError extends Error {
    constructor() {
        super("Invalid cursor format");
        this.name = "SessionListInvalidCursorError";
    }
}

export class SessionListUnavailableQueryError extends Error {
    constructor(readonly reason: "audience" | "scope" | "following" | "coordinator") {
        super(`Session list query ${reason} producer is unavailable`);
        this.name = "SessionListUnavailableQueryError";
    }
}

export async function readSessionListOwnerAccountModes(rows: readonly Readonly<{
    accountId: string;
    metadataLayoutVersion?: number | null;
}>[], reader: Pick<Tx, "account"> = db): Promise<ReadonlyMap<string, SessionMetadataOwnerAccountMode>> {
    return await readSessionMetadataOwnerAccountModes(
        reader,
        rows.filter((session) => requiresSessionMetadataOwnerAccountMode({ session })).map((session) => session.accountId),
    );
}

type LegacySessionListSource = Readonly<{
    kind: "legacy";
    storage: "active" | "archived";
    activeOnly?: boolean;
    cursor?: string;
    attentionCursor?: string;
    limit?: number;
    includeAttention?: boolean;
    includeActive?: boolean;
}>;

type FilteredSessionListSource = Readonly<{
    kind: "query";
    query: SessionListQueryV1;
}>;

type SessionListSource = LegacySessionListSource | FilteredSessionListSource;

/** One service owns legacy and strict-query cursor, row, pin and attention mechanics. */
export async function listSessionsForAccount(params: Readonly<{
    userId: string;
    authentication: SessionAccessAuthentication;
    source: SessionListSource;
    rowRepresentabilityWhere: Prisma.SessionWhereInput;
    timing: ReturnType<typeof createV2SessionListServerTiming>;
}>): Promise<V2SessionListResponse | SessionListQueryResponseV1 | SessionRuntimeManagedSubtreeListResponseV1 | null> {
    const source = params.source;
    if (params.authentication.sessionRuntimePrincipal) {
        if (source.kind !== 'query') throw new SessionListCredentialScopeDeniedError();
        return await listSessionRuntimeManagedSubtree({ ...params, source });
    }
    if (source.kind === "query") {
        return await listFilteredSessionsForAccount({
            userId: params.userId,
            authentication: params.authentication,
            source,
            rowRepresentabilityWhere: params.rowRepresentabilityWhere,
            timing: params.timing,
        });
    }
    let contributions: readonly SessionManagerContribution[] = [];
    return await readSnapshotWithCurrentAdmission(async (tx) => await params.timing.measureAsync("snapshot", async () => {
        const now = Date.now();
        const accessResolution = {
            where: buildSessionAccessWhere({
                accountId: params.userId,
                capability: "readTranscript",
                mode: "legacy_owner_or_direct",
            }),
            qualifiedTeamIds: new Set<string>(),
        };
        const readSource: SessionListReadSource = {
            kind: "effective",
            reader: tx,
            baseWhere: accessResolution.where,
            accessMode: "legacy_owner_or_direct",
            allowProjectionFallback: true,
            qualifiedTeamIds: accessResolution.qualifiedTeamIds,
            discussionReader: tx,
        };
        const where = conjoinSessionListWhereInputs(
            source.activeOnly
                ? createLegacyActiveSessionListWhere(now)
                : createSessionListStorageWhere(source.storage),
            params.rowRepresentabilityWhere,
        );
        const needsAttentionWhere = source.storage === "active"
            && (source.includeAttention === true || source.attentionCursor !== undefined);
        const attentionQuery = needsAttentionWhere
            ? createSessionPersonalAttentionQueryInTx(tx, {
                accountId: params.userId,
                qualifiedTeamIds: accessResolution.qualifiedTeamIds,
                now,
                captureObservedDiscussionFacts: true,
            })
            : undefined;
        const page = await listSessionRowsForAccount({
            ...params,
            storage: source.storage,
            activeOnly: source.activeOnly,
            cursor: source.cursor,
            attentionCursor: source.attentionCursor,
            limit: source.limit,
            includeAttention: source.includeAttention,
            includeActive: source.includeActive,
            where,
            readSource,
            attentionWhere: attentionQuery?.candidateWhere,
            attentionRowAdmission: attentionQuery?.admitRows,
            observedAttentionDiscussionFacts: attentionQuery?.observedDiscussionFacts,
            observedAttentionFailureSequences: attentionQuery?.observedFailureSequences,
            now,
        });
        return page && {
            ...page,
            sessions: await projectSessionManagerForRowsInTx(tx, {
                accountId: params.userId,
                authentication: params.authentication,
                sessions: page.sessions,
                accessMode: "legacy_owner_or_direct",
                nowMs: now,
                captureContributions: rows => { contributions = rows; },
            }),
        };
    }), async (tx, captured) => await params.timing.measureAsync("readmission", async () => {
        if (!captured) return captured;
        const admission = { accountId: params.userId, authentication: params.authentication, accessMode: "legacy_owner_or_direct" as const };
        const sessions = await readmitSessionRowsInTx(tx, admission, captured.sessions);
        return { ...captured, sessions: await readmitCapturedSessionManagerReferencesInTx(tx, { ...admission, sessions, contributions }) };
    }), { transactionClass: "session-listing-read" });
}

/** Restricted listing uses the canonical subtree, paging and shared row projection. */
async function listSessionRuntimeManagedSubtree(params: Readonly<{
    userId: string;
    authentication: SessionAccessAuthentication;
    source: FilteredSessionListSource;
    rowRepresentabilityWhere: Prisma.SessionWhereInput;
    timing: ReturnType<typeof createV2SessionListServerTiming>;
}>): Promise<SessionRuntimeManagedSubtreeListResponseV1> {
    const { query } = params.source;
    const principal = params.authentication.sessionRuntimePrincipal;
    if (!principal || principal.accountId !== params.userId || query.underSessionId !== principal.sessionId
        || query.scope !== 'all_accessible' || query.attention !== 'any'
        || query.audiences.length || query.tagIds.length || query.folderIds?.length
        || query.coordinator !== undefined || query.includeAttention === true || query.attentionCursor !== undefined
        || !query.includeInactive) throw new SessionListCredentialScopeDeniedError();
    const readIds = async (tx: Tx) => {
        const ids = await readSessionManagedSubtreeSessionIdsInTx(tx, {
            accountId: params.userId, rootSessionId: principal.sessionId, authentication: params.authentication,
            allowSessionRuntimeManagedSubtreeRead: true,
        });
        if (!ids.includes(principal.sessionId)) throw new SessionListCredentialScopeDeniedError();
        return ids;
    };
    const viewAccess = (sessionId: string): EffectiveSessionAccess => ({
        accountId: params.userId, sessionId, level: 'view', sources: [], relationshipKinds: [], audienceContext: null,
        capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [{ accessLevel: 'view', canApprovePermissions: false }] }),
    });
    return await readSnapshotWithCurrentAdmission(async tx => {
        const ids = await readIds(tx);
        const source: SessionListReadSource = { kind: 'effective', reader: tx, allowProjectionFallback: false,
            accessMode: 'effective_access_v1', baseWhere: conjoinSessionListWhereInputs(
                { id: { in: ids } }, createSessionListStorageWhere(query.storage), params.rowRepresentabilityWhere),
        };
        const cursor = query.cursor ? await resolveV2SessionListCursorForVisibleRows({ userId: params.userId,
            cursor: query.cursor, cursorRowWhere: {}, source }) : undefined;
        if (cursor === null) throw new SessionListInvalidCursorError();
        const rows = await findV2SessionListRows({ userId: params.userId, source, cursor,
            orderBy: V2_SESSION_LIST_ORDER_BY, take: (query.limit ?? SESSION_LIST_PAGE_DEFAULT_LIMIT) + 1 });
        const page = createV2SessionListRowPage({ rows, limit: query.limit ?? SESSION_LIST_PAGE_DEFAULT_LIMIT });
        const ownerAccountModes = await readSessionListOwnerAccountModes(page.rows, tx);
        const sessions = [];
        let metadataUpgradeRequiredCount = 0;
        for (const row of page.rows) {
            try {
                const { share: _share, ...session } = mapV2SessionListRow({ row, userId: params.userId, ownerAccountModes,
                    verifiedSessionRuntimePrincipal: true, effectiveAccess: viewAccess(row.id) });
                sessions.push(session);
            } catch (error) {
                if (!isSessionMetadataPrivacyUpgradeRequiredError(error)) throw error;
                metadataUpgradeRequiredCount += 1;
            }
        }
        return SessionRuntimeManagedSubtreeListResponseV1Schema.parse({ sessions, nextCursor: page.nextCursor, hasNext: page.hasNext,
            attentionNextCursor: null, attentionHasNext: false,
            ...(metadataUpgradeRequiredCount ? { metadataUpgradeRequiredCount } : {}) });
    }, async (tx, captured) => {
        const ids = new Set(await readIds(tx));
        const { sessionRuntimePrincipal: _principal, ...authentication } = params.authentication;
        const sessions = await readmitSessionRowsInTx(tx, { accountId: params.userId, authentication,
            accessMode: 'effective_access_v1' }, captured.sessions.filter(row => ids.has(row.id)));
        return SessionRuntimeManagedSubtreeListResponseV1Schema.parse({ ...captured, sessions: sessions.map(({ share: _share, ...row }) => ({ ...row,
            effectiveAccess: projectSessionEffectiveAccessV1(viewAccess(row.id)),
        })) });
    }, { transactionClass: 'session-listing-read' });
}

async function listSessionRowsForAccount(params: Readonly<{
    userId: string;
    authentication: SessionAccessAuthentication;
    storage: "active" | "archived";
    activeOnly?: boolean;
    cursor?: string;
    attentionCursor?: string;
    limit?: number;
    includeAttention?: boolean;
    includeActive?: boolean;
    where: Prisma.SessionWhereInput;
    readSource?: SessionListReadSource;
    attentionWhere?: Prisma.SessionWhereInput;
    rowAdmission?: SessionListRowAdmission;
    attentionRowAdmission?: SessionListRowAdmission;
    observedAttentionDiscussionFacts?: ReadonlyMap<string, SessionPersonalDiscussionFacts>;
    observedAttentionFailureSequences?: ReadonlyMap<string, number | null>;
    now?: number;
    rowRepresentabilityWhere: Prisma.SessionWhereInput;
    timing: ReturnType<typeof createV2SessionListServerTiming>;
}>): Promise<V2SessionListResponse | null> {
    const { userId, timing, where } = params;
    const limit = params.limit ?? SESSION_LIST_PAGE_DEFAULT_LIMIT;
    const metadataReader = params.readSource?.reader ?? db;
    const readAdmission = params.readSource
        ? { source: params.readSource }
        : { authentication: params.authentication };

    if (params.activeOnly) {
        const rows = await timing.measureAsync("query", () => findV2SessionListRows({
            userId, where, ...readAdmission, orderBy: V2_ACTIVE_SESSION_LIST_ORDER_BY, take: limit,
        }));
        const ownerAccountModes = await readSessionListOwnerAccountModes(rows, metadataReader);
        const discussionFacts = await readSessionListViewerDiscussionFacts(
            rows,
            userId,
            params.readSource?.discussionReader,
            params.observedAttentionDiscussionFacts,
        );
        const otherNamedCollaboratorFacts = await readSessionListOtherNamedCollaboratorFacts(rows, userId, params.readSource?.discussionReader);
        const latestFailureSequences = await loadSessionLatestFailureSequencesInTx(params.readSource?.discussionReader ?? db, rows, params.observedAttentionFailureSequences);
        return timing.measure("page", () => ({ ...mapV2SessionListRows({
            rows, userId, ownerAccountModes, discussionFacts, otherNamedCollaboratorFacts, latestFailureSequences,
            qualifiedTeamIds: params.readSource?.qualifiedTeamIds,
            accessMode: params.readSource?.accessMode,
            now: params.now,
        }) }));
    }

    if (params.attentionCursor) {
        const cursor = await timing.measureAsync("cursor", () => resolveV2SessionListCursorForVisibleRows({
            userId,
            cursor: params.attentionCursor,
            // An attention continuation identifies the last candidate examined,
            // which may itself have been rejected by the personal projector.
            // Validate it against the candidate corpus, never the admitted rows.
            cursorRowWhere: conjoinSessionListWhereInputs(where, params.attentionWhere),
            ...(params.readSource
                ? { source: params.readSource }
                : { authentication: params.authentication }),
        }));
        if (!cursor) throw new SessionListInvalidCursorError();
        const page = await createV2SessionAttentionPage({
            userId,
            authentication: params.authentication,
            where,
            cursor,
            candidateLimit: limit,
            source: params.readSource,
            attentionWhere: params.attentionWhere,
            rowAdmission: params.attentionRowAdmission,
            now: params.now,
            timing: timing.initialPageTiming(),
        });
        const ownerAccountModes = await readSessionListOwnerAccountModes(page.rows, metadataReader);
        const discussionFacts = await readSessionListViewerDiscussionFacts(
            page.rows,
            userId,
            params.readSource?.discussionReader,
            params.observedAttentionDiscussionFacts,
        );
        const otherNamedCollaboratorFacts = await readSessionListOtherNamedCollaboratorFacts(page.rows, userId, params.readSource?.discussionReader);
        const latestFailureSequences = await loadSessionLatestFailureSequencesInTx(params.readSource?.discussionReader ?? db, page.rows, params.observedAttentionFailureSequences);
        return {
            ...mapV2SessionListRows({
                rows: page.rows, userId, ownerAccountModes, discussionFacts, otherNamedCollaboratorFacts, latestFailureSequences,
                qualifiedTeamIds: params.readSource?.qualifiedTeamIds,
                accessMode: params.readSource?.accessMode,
                now: params.now,
            }),
            nextCursor: null,
            hasNext: false,
            attentionNextCursor: page.attentionNextCursor,
            attentionHasNext: page.attentionHasNext,
        };
    }

    const pinnedSessionIds = params.storage === "active" && !params.cursor
        ? await timing.measureAsync("cursor", () => fetchSessionOrganizationPinnedSessionIds(
            userId,
            params.authentication,
            params.readSource ? {
                reader: params.readSource.reader,
                sessionWhere: conjoinSessionListWhereInputs(params.readSource.baseWhere, where),
            } : undefined,
        ))
        : [];
    let cursor: V2SessionListCursorV2 | undefined;
    if (params.cursor) {
        const decoded = await timing.measureAsync("cursor", () => resolveV2SessionListCursorForVisibleRows({
            userId, cursor: params.cursor, cursorRowWhere: where, ...readAdmission,
            rowAdmission: params.rowAdmission,
        }));
        if (!decoded) throw new SessionListInvalidCursorError();
        cursor = decoded;
    }
    const rows = await timing.measureAsync("query", () => findV2SessionListRows({
        userId, where, cursor, ...readAdmission, orderBy: V2_SESSION_LIST_ORDER_BY, take: limit + 1,
        rowAdmission: params.rowAdmission,
    }));
    const includeAttention = params.storage === "active" && !params.cursor && params.includeAttention === true;
    const includeActive = params.storage === "active" && !params.cursor && params.includeActive === true;
    if (!params.cursor && (pinnedSessionIds.length > 0 || includeAttention || includeActive)) {
        return await createV2SessionListInitialPage({
            userId,
            authentication: params.authentication,
            where,
            readOwnerAccountModes: (accountIds) => readSessionMetadataOwnerAccountModes(metadataReader, accountIds),
            readViewerDiscussionFacts: (pageRows) => readSessionListViewerDiscussionFacts(
                pageRows,
                userId,
                params.readSource?.discussionReader,
                params.observedAttentionDiscussionFacts,
            ),
            readOtherNamedCollaboratorFacts: (pageRows) => readSessionListOtherNamedCollaboratorFacts(pageRows, userId, params.readSource?.discussionReader),
            readLatestFailureSequences: (pageRows) => loadSessionLatestFailureSequencesInTx(params.readSource?.discussionReader ?? db, pageRows, params.observedAttentionFailureSequences),
            pageRows: rows,
            limit,
            pinnedSessionIds,
            includeAttentionRows: includeAttention,
            includeActiveRows: includeActive,
            activeRowsLimit: V2_ACTIVE_SESSION_LIST_ROW_LIMIT,
            source: params.readSource,
            attentionWhere: params.attentionWhere,
            rowAdmission: params.rowAdmission,
            attentionRowAdmission: params.attentionRowAdmission,
            now: params.now,
            timing: timing.initialPageTiming(),
        });
    }
    const page = createV2SessionListRowPage({ rows, limit });
    const ownerAccountModes = await readSessionListOwnerAccountModes(page.rows, metadataReader);
    const discussionFacts = await readSessionListViewerDiscussionFacts(
        page.rows,
        userId,
        params.readSource?.discussionReader,
        params.observedAttentionDiscussionFacts,
    );
    const otherNamedCollaboratorFacts = await readSessionListOtherNamedCollaboratorFacts(page.rows, userId, params.readSource?.discussionReader);
    const latestFailureSequences = await loadSessionLatestFailureSequencesInTx(params.readSource?.discussionReader ?? db, page.rows, params.observedAttentionFailureSequences);
    return timing.measure("page", () => ({
        ...mapV2SessionListRows({
            rows: page.rows, userId, ownerAccountModes, discussionFacts, otherNamedCollaboratorFacts, latestFailureSequences,
            qualifiedTeamIds: params.readSource?.qualifiedTeamIds,
            accessMode: params.readSource?.accessMode,
            now: params.now,
        }),
        nextCursor: page.nextCursor,
        hasNext: page.hasNext,
    }));
}

async function listFilteredSessionsForAccount(params: Readonly<{
    userId: string;
    authentication: SessionAccessAuthentication;
    source: FilteredSessionListSource;
    rowRepresentabilityWhere: Prisma.SessionWhereInput;
    timing: ReturnType<typeof createV2SessionListServerTiming>;
}>): Promise<SessionListQueryResponseV1 | null> {
    const { query } = params.source;
    // Decided before the listing transaction opens, on the Home-effective configuration.
    if (query.scope === "following" && !await isServerFeatureEnabledForHome("sessions.following")) {
        throw new SessionListUnavailableQueryError("following");
    }
    if (query.audiences.some((audience) => audience.kind !== "outside_teams")
        && !isSessionCollaborationEnabled()) {
        throw new SessionListUnavailableQueryError("audience");
    }

    let contributions: readonly SessionManagerContribution[] = [];
    return await readSnapshotWithCurrentAdmission(async (tx) => await params.timing.measureAsync("snapshot", async () => {
        const accessResolution = await resolveEffectiveSessionAccessWhere({
            tx,
            accountId: params.userId,
            capability: "readTranscript",
            mode: "effective_access_v1",
            authentication: params.authentication,
        });
        const accessWhere = accessResolution.where;
        const audienceWhere = await createApplicableAudienceWhere({
            tx,
            accountId: params.userId,
            audiences: query.audiences,
            authentication: params.authentication,
            collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
        });
        const now = Date.now();
        let scopeWhere;
        try {
            scopeWhere = await createSessionListScopeWhere({ tx, accountId: params.userId, scope: query.scope });
        } catch {
            throw new SessionListUnavailableQueryError("scope");
        }
        const needsAttentionWhere = query.attention === "needs_my_attention"
            || !query.includeInactive
            || query.includeAttention === true
            || query.attentionCursor !== undefined;
        const attentionQuery = createSessionPersonalAttentionQueryInTx(tx, {
            accountId: params.userId,
            qualifiedTeamIds: accessResolution.qualifiedTeamIds,
            now,
            captureObservedDiscussionFacts: true,
        });
        const attentionWhere = needsAttentionWhere
            ? attentionQuery.candidateWhere
            : { id: { in: [] } };
        const admitAttentionRows: SessionListRowAdmission = attentionQuery.admitRows;
        const attentionRowAdmission: SessionListRowAdmission | undefined = query.attention === "needs_my_attention"
            ? admitAttentionRows
            : !query.includeInactive
                ? async (rows) => {
                    // Publication decides liveness, not the raw stored column:
                    // a row that projects `active: false` must earn its place
                    // through attention like any other inactive row.
                    const isPublishedActive = (row: typeof rows[number]) => (
                        row.active && hasSessionTranscriptPublicationLiveFacts(row)
                    );
                    const inactiveRows = rows.filter((row) => !isPublishedActive(row));
                    if (inactiveRows.length === 0) return rows;
                    const admittedInactiveIds = new Set(
                        (await admitAttentionRows(inactiveRows)).map((row) => row.id),
                    );
                    return rows.filter((row) => isPublishedActive(row) || admittedInactiveIds.has(row.id));
                }
                : undefined;
        const ruleReceiverCounts = await readAccountFollowRuleReceiverCountsInTx(tx, {
            accountId: params.userId, authentication: params.authentication,
        });
        const admitCoordinators: SessionListRowAdmission = async rows => {
            const projected = await projectSessionManagerForRowsInTx(tx, {
                accountId: params.userId, authentication: params.authentication, sessions: rows,
                accessMode: 'effective_access_v1', collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
                nowMs: now, ruleReceiverCounts,
            });
            const selected = new Set<string>();
            for (const row of projected) {
                const coordinator = deriveSessionCoordinatorV1(row);
                if (coordinator === undefined) throw new SessionListUnavailableQueryError('coordinator');
                if (coordinator) selected.add(row.id);
            }
            return rows.filter(row => selected.has(row.id));
        };
        const rowAdmission: SessionListRowAdmission | undefined = query.coordinator === undefined ? attentionRowAdmission
            : async rows => admitCoordinators(attentionRowAdmission ? await attentionRowAdmission(rows) : rows);
        const admitAttentionCandidates: SessionListRowAdmission = query.coordinator === undefined ? admitAttentionRows
            : async rows => admitCoordinators(await admitAttentionRows(rows));
        const baseWhere = createFilteredSessionListWhere({
            accountId: params.userId,
            query,
            accessWhere,
            scopeWhere,
            audienceWhere,
            attentionWhere,
        });
        const subtreeWhere: Prisma.SessionWhereInput = query.underSessionId
            ? { id: { in: await readSessionManagedSubtreeSessionIdsInTx(tx, {
                accountId: params.userId,
                rootSessionId: query.underSessionId,
                authentication: params.authentication,
                collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
            }) } }
            : {};
        const readSource: SessionListReadSource = {
            kind: "effective",
            reader: tx,
            baseWhere: conjoinSessionListWhereInputs(baseWhere, subtreeWhere, params.rowRepresentabilityWhere),
            accessMode: "effective_access_v1",
            allowProjectionFallback: false,
            qualifiedTeamIds: accessResolution.qualifiedTeamIds,
            collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
            discussionReader: tx,
        };
        const page = await listSessionRowsForAccount({
            userId: params.userId,
            authentication: params.authentication,
            storage: query.storage,
            cursor: query.cursor,
            attentionCursor: query.attentionCursor,
            limit: query.limit,
            includeAttention: query.includeAttention,
            where: {},
            readSource,
            attentionWhere,
            rowAdmission,
            attentionRowAdmission: admitAttentionCandidates,
            observedAttentionDiscussionFacts: attentionQuery.observedDiscussionFacts,
            observedAttentionFailureSequences: attentionQuery.observedFailureSequences,
            now,
            rowRepresentabilityWhere: params.rowRepresentabilityWhere,
            timing: params.timing,
        });
        return page && SessionListQueryResponseV1Schema.parse({
            sessions: await projectSessionManagerForRowsInTx(tx, {
                accountId: params.userId,
                authentication: params.authentication,
                sessions: page.sessions,
                accessMode: "effective_access_v1",
                collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
                nowMs: now,
                ruleReceiverCounts,
                captureContributions: rows => { contributions = rows; },
            }),
            nextCursor: page.nextCursor ?? null,
            hasNext: page.hasNext ?? false,
            attentionNextCursor: page.attentionNextCursor ?? null,
            attentionHasNext: page.attentionHasNext ?? false,
            ...(page.metadataUpgradeRequiredCount !== undefined
                ? { metadataUpgradeRequiredCount: page.metadataUpgradeRequiredCount }
                : {}),
        });
    }), async (tx, captured) => await params.timing.measureAsync("readmission", async () => {
        if (!captured) return captured;
        const admission = { accountId: params.userId, authentication: params.authentication, accessMode: "effective_access_v1" as const };
        const sessions = await readmitSessionRowsInTx(tx, admission, captured.sessions);
        const current = await readmitCapturedSessionManagerReferencesInTx(tx, { ...admission, sessions, contributions });
        return SessionListQueryResponseV1Schema.parse({
            ...captured,
            // Revoking the last readable child can remove coordinator membership
            // during final admission, just as it removes that child's counts.
            sessions: query.coordinator === undefined ? current : current.filter(row => deriveSessionCoordinatorV1(row) === true),
        });
    }), { transactionClass: "session-listing-read" });
}
