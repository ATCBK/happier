import {
    teamGroupsQueryKeyV1,
    type TeamCredentialResourceCatalogEntryV1,
    type TeamCredentialResourceSummaryV1,
    type TeamCredentialViewerCapabilitiesV1,
    type TeamGroupV1,
    type TeamSummaryV1,
} from '@happier-dev/protocol/teams';
import type { ProviderBrokerApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';

import {
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import {
    serverAccountScopedTeamKey,
    type TeamAddress,
} from '@/sync/domains/teams/teamAddress';
import {
    isAuthoritativeScopedSnapshotRefusal,
    reachabilityForScopedSnapshotError,
    type ScopedSnapshotError,
    type ScopedSnapshotReachability,
    type ScopedSnapshotStatus,
} from '@/sync/domains/scope/scopedSnapshotFacts';

/**
 * Server-Account-qualified Team directory, Team detail and Team Group snapshots.
 *
 * Every row is keyed by `ServerAccountScope`, and Team detail additionally by
 * `TeamAddress`: two Homes may legitimately hold the same Team ID, and two
 * Accounts on one Home see different Teams, roles and capabilities. Neither may
 * ever read the other's rows.
 *
 * The projections are fully reconstructible from their Home, so invalidation
 * only marks rows stale. There is no Team cursor, event replay, polling timer or
 * global active-Team state here.
 */

export type TeamsDirectorySnapshot = Readonly<{
    scope: ServerAccountScope;
    /** The protocol's own query identity, so no second keying rule exists. */
    queryKey: string;
    status: ScopedSnapshotStatus;
    /** Accumulated pages in server order. Retained across refresh and failure. */
    data: readonly TeamSummaryV1[] | null;
    nextCursor: string | null;
    lastObservedAt: number | null;
    stale: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

/**
 * One Team's Groups for one archive filter.
 *
 * Groups are keyed by the full `ServerAccountScope` plus `TeamAddress` plus the
 * protocol's own query identity, because every one of those can legitimately
 * repeat: two Homes hold the same Team ID, two Accounts on one Home see
 * different Groups, and active and archived are separate sequences with
 * separate orderings.
 */
export type TeamGroupsSnapshot = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    /** The protocol's own query identity, so no second keying rule exists. */
    queryKey: string;
    status: ScopedSnapshotStatus;
    /** Accumulated pages in server order. Retained across refresh and failure. */
    data: readonly TeamGroupV1[] | null;
    nextCursor: string | null;
    lastObservedAt: number | null;
    stale: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

export type TeamGroupSnapshot = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    groupId: string;
    status: ScopedSnapshotStatus;
    data: TeamGroupV1 | null;
    lastObservedAt: number | null;
    stale: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

export type TeamSnapshot = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    status: ScopedSnapshotStatus;
    data: TeamSummaryV1 | null;
    lastObservedAt: number | null;
    stale: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

/**
 * One Team's shared credential resources as this exact viewer sees them.
 *
 * The Home decides the administration rows and management capabilities in one
 * read, so those facts remain together. The filter-independent recipient
 * catalog is a separate authority answer retained below.
 *
 * Pages accumulate in the Home's stable order. A failed continuation keeps
 * both the rows and cursor so retry resumes the exact sequence position.
 */
export type TeamCredentialResourcesSnapshot = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    /** The protocol list query represented by this retained sequence. */
    queryKey: string;
    status: ScopedSnapshotStatus;
    /** Retained across refresh and failure so a list never blanks. */
    data: readonly TeamCredentialResourceSummaryV1[] | null;
    nextCursor: string | null;
    viewer: TeamCredentialViewerCapabilitiesV1 | null;
    lastObservedAt: number | null;
    stale: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

/**
 * Recipient-safe credential choices for one exact Home Account, Team and optional application.
 *
 * This is deliberately independent of administration list query identity:
 * changing a manager's search/filter must not reopen the same entitlement
 * read, and an entitlement outage must not blank otherwise usable admin rows.
 */
export type TeamCredentialResourceCatalogSnapshot = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    application?: ProviderBrokerApplicationBindingV1;
    status: ScopedSnapshotStatus;
    data: readonly TeamCredentialResourceCatalogEntryV1[] | null;
    lastObservedAt: number | null;
    stale: boolean;
    /** Last admitted picker choices survive advisory rereads, never grant launch authority. */
    selectionCurrent: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

/** One exact administration resource under its full Home/Account/Team scope. */
export type TeamCredentialResourceSnapshot = Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    resourceId: string;
    status: ScopedSnapshotStatus;
    /** Retained across a transient refresh failure; withdrawn on a settled refusal. */
    data: TeamCredentialResourceSummaryV1 | null;
    lastObservedAt: number | null;
    stale: boolean;
    reachability: ScopedSnapshotReachability;
    error: ScopedSnapshotError | null;
}>;

const directories = new Map<string, TeamsDirectorySnapshot>();
const teams = new Map<string, TeamSnapshot>();
const groupLists = new Map<string, TeamGroupsSnapshot>();
const groups = new Map<string, TeamGroupSnapshot>();
const credentialLists = new Map<string, TeamCredentialResourcesSnapshot>();
const credentialCatalogs = new Map<string, TeamCredentialResourceCatalogSnapshot>();
const credentialResources = new Map<string, TeamCredentialResourceSnapshot>();
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            // One subscriber cannot prevent its siblings from observing.
        }
    }
}

function directoryKey(scope: ServerAccountScope, queryKey: string): string {
    return `${serverAccountScopeKeySuffix(scope)}${queryKey.length}:${queryKey}`;
}

function groupListKey(scope: ServerAccountScope, address: TeamAddress, queryKey: string): string {
    return `${serverAccountScopedTeamKey(scope, address)}${queryKey.length}:${queryKey}`;
}

function groupKey(scope: ServerAccountScope, address: TeamAddress, groupId: string): string {
    return `${serverAccountScopedTeamKey(scope, address)}${groupId.length}:${groupId}`;
}

function credentialListKey(scope: ServerAccountScope, address: TeamAddress, queryKey: string): string {
    return `${serverAccountScopedTeamKey(scope, address)}${queryKey.length}:${queryKey}`;
}

function credentialResourceKey(scope: ServerAccountScope, address: TeamAddress, resourceId: string): string {
    return `${serverAccountScopedTeamKey(scope, address)}${resourceId.length}:${resourceId}`;
}

function credentialSnapshotMatches(
    snapshot: Readonly<{ scope: ServerAccountScope; address: TeamAddress }>,
    scope: ServerAccountScope,
    address: TeamAddress,
): boolean {
    return snapshot.scope.serverId === scope.serverId
        && snapshot.scope.accountId === scope.accountId
        && snapshot.address.serverId === address.serverId
        && snapshot.address.teamId === address.teamId;
}

/**
 * The one subscription for every Team projection in this owner.
 *
 * A surface subscribes once and reads whichever rows it needs synchronously, so
 * a list of cards never becomes a list of subscriptions.
 */
export function subscribeTeamsSnapshots(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getTeamsDirectorySnapshot(
    scope: ServerAccountScope | null | undefined,
    queryKey: string,
): TeamsDirectorySnapshot | null {
    if (!scope) return null;
    return directories.get(directoryKey(scope, queryKey)) ?? null;
}

export function getTeamSnapshot(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
): TeamSnapshot | null {
    if (!scope || !address) return null;
    return teams.get(serverAccountScopedTeamKey(scope, address)) ?? null;
}

export function getTeamGroupsSnapshot(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    queryKey: string,
): TeamGroupsSnapshot | null {
    if (!scope || !address) return null;
    return groupLists.get(groupListKey(scope, address, queryKey)) ?? null;
}

export function getTeamGroupSnapshot(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    groupId: string,
): TeamGroupSnapshot | null {
    if (!scope || !address || groupId === '') return null;
    return groups.get(groupKey(scope, address, groupId)) ?? null;
}

export function getTeamCredentialResourcesSnapshot(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    queryKey = '',
): TeamCredentialResourcesSnapshot | null {
    if (!scope || !address) return null;
    return credentialLists.get(credentialListKey(scope, address, queryKey)) ?? null;
}

export function getTeamCredentialResourceCatalogSnapshot(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    application?: ProviderBrokerApplicationBindingV1,
): TeamCredentialResourceCatalogSnapshot | null {
    if (!scope || !address) return null;
    return credentialCatalogs.get(teamCredentialResourceCatalogKey(scope, address, application)) ?? null;
}

/** One identity shared by the retained snapshot and its in-flight loader. */
export function teamCredentialResourceCatalogKey(scope: ServerAccountScope, address: TeamAddress,
    application?: ProviderBrokerApplicationBindingV1): string {
    return JSON.stringify([serverAccountScopedTeamKey(scope, address), application ? [application.agentTargetKey,
        application.implementationIdentity.pluginId, application.implementationIdentity.localId,
        application.endpointTemplateId, application.protocol] : null]);
}

/** Recipient-safe cached names for an exact Account; display reads confer no resource authority. */
export function readTeamCredentialResourceCatalogs(scope: ServerAccountScope): readonly TeamCredentialResourceCatalogEntryV1[] {
    return [...credentialCatalogs.values()].flatMap(snapshot => snapshot.scope.serverId === scope.serverId
        && snapshot.scope.accountId === scope.accountId ? snapshot.data ?? [] : []);
}

export function getTeamCredentialResourceSnapshot(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    resourceId: string,
): TeamCredentialResourceSnapshot | null {
    if (!scope || !address || resourceId === '') return null;
    return credentialResources.get(credentialResourceKey(scope, address, resourceId)) ?? null;
}

/**
 * One resource by id from the projection the Team already loaded.
 *
 * Exact-resource observations take precedence. A presentation-ready row from
 * an already-loaded administration list remains a useful fallback while its
 * exact read is opening, without making the detail route own list pagination.
 */
export function readTeamCredentialResource(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    resourceId: string,
): TeamCredentialResourceSummaryV1 | null {
    if (!scope || !address || resourceId === '') return null;
    const exact = getTeamCredentialResourceSnapshot(scope, address, resourceId)?.data ?? null;
    if (exact) return exact;
    // A row opened from a search/filter result remains the same Home-authorized
    // administration row. Search identity scopes retained sequences, not the
    // resource itself, so detail may read it from any exact-scope sequence.
    let selected: Readonly<{ row: TeamCredentialResourceSummaryV1; observedAt: number }> | null = null;
    for (const snapshot of credentialLists.values()) {
        if (!credentialSnapshotMatches(snapshot, scope, address)) continue;
        const resource = snapshot.data?.find((row) => row.id === resourceId);
        if (!resource) continue;
        const observedAt = snapshot.lastObservedAt ?? -1;
        if (selected === null || observedAt >= selected.observedAt) {
            selected = { row: resource, observedAt };
        }
    }
    return selected?.row ?? null;
}

export function beginTeamCredentialResourceLoad(
    scope: ServerAccountScope,
    address: TeamAddress,
    resourceId: string,
): void {
    const current = getTeamCredentialResourceSnapshot(scope, address, resourceId);
    const status: ScopedSnapshotStatus = current?.data ? 'refreshing' : 'loading';
    if (current && current.status === status && current.error === null) return;
    credentialResources.set(credentialResourceKey(scope, address, resourceId), Object.freeze({
        scope,
        address,
        resourceId,
        status,
        data: current?.data ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
    notify();
}

export function applyTeamCredentialResource(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    resource: TeamCredentialResourceSummaryV1;
    observedAt: number;
    current?: boolean;
}>): void {
    const current = getTeamCredentialResourceSnapshot(params.scope, params.address, params.resource.id);
    const data = current?.data && areProjectionsEquivalent(current.data, params.resource)
        ? current.data
        : params.resource;
    credentialResources.set(credentialResourceKey(params.scope, params.address, params.resource.id), Object.freeze({
        scope: params.scope,
        address: params.address,
        resourceId: params.resource.id,
        status: 'ready',
        data,
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }));
    notify();
}

export function applyTeamCredentialResourceFailure(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    resourceId: string;
    error: ScopedSnapshotError;
}>): void {
    const current = getTeamCredentialResourceSnapshot(params.scope, params.address, params.resourceId);
    const withdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    credentialResources.set(credentialResourceKey(params.scope, params.address, params.resourceId), Object.freeze({
        scope: params.scope,
        address: params.address,
        resourceId: params.resourceId,
        status: 'error',
        data: withdrawn ? null : current?.data ?? null,
        lastObservedAt: withdrawn ? null : current?.lastObservedAt ?? null,
        stale: !withdrawn && Boolean(current?.data),
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: params.error,
    }));
    notify();
}

/**
 * The synchronous Group readers for surfaces that need a Group's name or its
 * Team-qualified identity while rendering a row.
 *
 * Session rows, Activity, Inbox and notification context all need a label for a
 * Group they did not open, and there may be many of them on one screen. They
 * subscribe once through `subscribeTeamsSnapshots` and call these; there is no
 * per-card subscription and no separate label cache, because the projection
 * these read is the same one the Groups surface already loads.
 *
 * Rows that a later refresh marked stale are still returned: a stale Group name
 * is the last thing the Home actually said, and blanking a label while a refresh
 * runs would be less truthful than showing it.
 */
export function readTeamGroups(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    archived: 'active' | 'archived',
): readonly TeamGroupV1[] | null {
    if (!scope || !address) return null;
    const queryKey = teamGroupsQueryKeyV1({ v: 1, teamId: address.teamId, archived });
    return getTeamGroupsSnapshot(scope, address, queryKey)?.data ?? null;
}

/** A recipient-scoped Team name from the detail or directory already read. */
export function readTeam(scope: ServerAccountScope, address: TeamAddress): TeamSummaryV1 | null {
    const detail = getTeamSnapshot(scope, address)?.data;
    if (detail) return detail;
    if (scope.serverId !== address.serverId) return null;
    for (const snapshot of directories.values()) {
        if (snapshot.scope.serverId !== scope.serverId || snapshot.scope.accountId !== scope.accountId) continue;
        const team = snapshot.data?.find(row => row.id === address.teamId);
        if (team) return team;
    }
    return null;
}

/**
 * One Group by id, from whichever projection already holds it: its own detail
 * read, or the Groups sequence a surface loaded. A caller that only needs a
 * label therefore does not force a detail read it would otherwise not perform.
 */
export function readTeamGroup(
    scope: ServerAccountScope | null | undefined,
    address: TeamAddress | null | undefined,
    groupId: string,
): TeamGroupV1 | null {
    if (!scope || !address || groupId === '') return null;
    const detail = getTeamGroupSnapshot(scope, address, groupId)?.data ?? null;
    if (detail) return detail;
    for (const archived of ['active', 'archived'] as const) {
        const found = readTeamGroups(scope, address, archived)?.find((row) => row.id === groupId);
        if (found) return found;
    }
    return null;
}

/**
 * Both projections originate from one strict schema parse, so their key order is
 * deterministic and a serialized comparison is a sound equivalence check here.
 */
function areProjectionsEquivalent(a: unknown, b: unknown): boolean {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function areTeamSummariesEquivalent(a: TeamSummaryV1, b: TeamSummaryV1): boolean {
    return areProjectionsEquivalent(a, b);
}

/**
 * Reuses the object already on screen whenever a Team's content is unchanged, so
 * an unrelated Team's mutation cannot re-render every row in a long directory.
 */
function preserveUnchangedTeams(
    previous: readonly TeamSummaryV1[] | null,
    incoming: readonly TeamSummaryV1[],
): readonly TeamSummaryV1[] {
    if (!previous || previous.length === 0) return Object.freeze([...incoming]);
    const previousById = new Map(previous.map((team) => [team.id, team]));
    return Object.freeze(incoming.map((team) => {
        const existing = previousById.get(team.id);
        return existing && areTeamSummariesEquivalent(existing, team) ? existing : team;
    }));
}

export function beginTeamsDirectoryLoad(scope: ServerAccountScope, queryKey: string): void {
    const current = getTeamsDirectorySnapshot(scope, queryKey);
    const status: ScopedSnapshotStatus = current?.data ? 'refreshing' : 'loading';
    if (current && current.status === status && current.error === null) return;
    directories.set(directoryKey(scope, queryKey), Object.freeze({
        scope,
        queryKey,
        status,
        data: current?.data ?? null,
        nextCursor: current?.nextCursor ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
    notify();
}

/**
 * Publishes one page. `append` continues an existing sequence; otherwise the
 * page replaces the directory, still reusing unchanged Team objects.
 */
export function applyTeamsDirectoryPage(params: Readonly<{
    scope: ServerAccountScope;
    queryKey: string;
    items: readonly TeamSummaryV1[];
    nextCursor?: string | null;
    observedAt: number;
    append?: boolean;
    current?: boolean;
}>): void {
    const current = getTeamsDirectorySnapshot(params.scope, params.queryKey);
    const incoming = params.append === true
        ? [...(current?.data ?? []), ...params.items]
        : params.items;
    directories.set(directoryKey(params.scope, params.queryKey), Object.freeze({
        scope: params.scope,
        queryKey: params.queryKey,
        status: 'ready',
        data: preserveUnchangedTeams(current?.data ?? null, incoming),
        nextCursor: params.nextCursor ?? null,
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }));
    notify();
}

export function applyTeamsDirectoryFailure(params: Readonly<{
    scope: ServerAccountScope;
    queryKey: string;
    error: ScopedSnapshotError;
}>): void {
    const current = getTeamsDirectorySnapshot(params.scope, params.queryKey);
    const withdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    directories.set(directoryKey(params.scope, params.queryKey), Object.freeze({
        scope: params.scope,
        queryKey: params.queryKey,
        status: 'error',
        // The last known directory stays visible and is marked stale rather than
        // flashing an empty Teams list.
        data: withdrawn ? null : current?.data ?? null,
        nextCursor: withdrawn ? null : current?.nextCursor ?? null,
        lastObservedAt: withdrawn ? null : current?.lastObservedAt ?? null,
        stale: !withdrawn && Boolean(current?.data),
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: params.error,
    }));
    notify();
}

/**
 * Reuses the object already on screen whenever a Group is unchanged, so a rename
 * of one Group cannot re-render every row, and so a Group label a surface is
 * already holding stays referentially stable across a refresh.
 */
function preserveUnchangedGroups(
    previous: readonly TeamGroupV1[] | null,
    incoming: readonly TeamGroupV1[],
): readonly TeamGroupV1[] {
    if (!previous || previous.length === 0) return Object.freeze([...incoming]);
    const previousById = new Map(previous.map((row) => [row.id, row]));
    return Object.freeze(incoming.map((row) => {
        const existing = previousById.get(row.id);
        return existing && areProjectionsEquivalent(existing, row) ? existing : row;
    }));
}

export function beginTeamGroupsLoad(
    scope: ServerAccountScope,
    address: TeamAddress,
    queryKey: string,
): void {
    const current = getTeamGroupsSnapshot(scope, address, queryKey);
    const status: ScopedSnapshotStatus = current?.data ? 'refreshing' : 'loading';
    if (current && current.status === status && current.error === null) return;
    groupLists.set(groupListKey(scope, address, queryKey), Object.freeze({
        scope,
        address,
        queryKey,
        status,
        data: current?.data ?? null,
        nextCursor: current?.nextCursor ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
    notify();
}

export function applyTeamGroupsPage(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    queryKey: string;
    items: readonly TeamGroupV1[];
    nextCursor: string | null;
    observedAt: number;
    append?: boolean;
    current?: boolean;
}>): void {
    const current = getTeamGroupsSnapshot(params.scope, params.address, params.queryKey);
    const incoming = params.append === true
        ? [...(current?.data ?? []), ...params.items]
        : params.items;
    groupLists.set(groupListKey(params.scope, params.address, params.queryKey), Object.freeze({
        scope: params.scope,
        address: params.address,
        queryKey: params.queryKey,
        status: 'ready',
        data: preserveUnchangedGroups(current?.data ?? null, incoming),
        nextCursor: params.nextCursor ?? null,
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }));
    notify();
}

export function applyTeamGroupsFailure(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    queryKey: string;
    error: ScopedSnapshotError;
}>): void {
    const current = getTeamGroupsSnapshot(params.scope, params.address, params.queryKey);
    const withdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    groupLists.set(groupListKey(params.scope, params.address, params.queryKey), Object.freeze({
        scope: params.scope,
        address: params.address,
        queryKey: params.queryKey,
        status: 'error',
        // The pages already read stay visible and are marked stale rather than
        // blanking a Groups list because a later read failed.
        data: withdrawn ? null : current?.data ?? null,
        nextCursor: withdrawn ? null : current?.nextCursor ?? null,
        lastObservedAt: withdrawn ? null : current?.lastObservedAt ?? null,
        stale: !withdrawn && Boolean(current?.data),
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: params.error,
    }));
    notify();
}

function preserveUnchangedCredentialResources(
    previous: readonly TeamCredentialResourceSummaryV1[] | null,
    incoming: readonly TeamCredentialResourceSummaryV1[],
): readonly TeamCredentialResourceSummaryV1[] {
    if (!previous || previous.length === 0) return Object.freeze([...incoming]);
    const previousById = new Map(previous.map((row) => [row.id, row]));
    return Object.freeze(incoming.map((row) => {
        const existing = previousById.get(row.id);
        return existing && areProjectionsEquivalent(existing, row) ? existing : row;
    }));
}

function preserveUnchangedCredentialCatalog(
    previous: readonly TeamCredentialResourceCatalogEntryV1[] | null,
    incoming: readonly TeamCredentialResourceCatalogEntryV1[],
): readonly TeamCredentialResourceCatalogEntryV1[] {
    if (!previous || previous.length === 0) return Object.freeze([...incoming]);
    const previousById = new Map(previous.map((row) => [row.id, row]));
    return Object.freeze(incoming.map((row) => {
        const existing = previousById.get(row.id);
        return existing && areProjectionsEquivalent(existing, row) ? existing : row;
    }));
}

export function beginTeamCredentialResourcesLoad(
    scope: ServerAccountScope,
    address: TeamAddress,
    queryKey = '',
): void {
    const current = getTeamCredentialResourcesSnapshot(scope, address, queryKey);
    const status: ScopedSnapshotStatus = current?.data ? 'refreshing' : 'loading';
    if (current && current.status === status && current.error === null) return;
    credentialLists.set(credentialListKey(scope, address, queryKey), Object.freeze({
        scope,
        address,
        queryKey,
        status,
        data: current?.data ?? null,
        nextCursor: current?.nextCursor ?? null,
        viewer: current?.viewer ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
    notify();
}

export function applyTeamCredentialResourcesPage(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    queryKey?: string;
    resources: readonly TeamCredentialResourceSummaryV1[];
    nextCursor?: string | null;
    viewer: TeamCredentialViewerCapabilitiesV1;
    observedAt: number;
    current?: boolean;
    append?: boolean;
}>): void {
    const queryKey = params.queryKey ?? '';
    const current = getTeamCredentialResourcesSnapshot(params.scope, params.address, queryKey);
    const resources = params.append && current?.data
        ? [...current.data, ...params.resources.filter((incoming) => (
            !current.data?.some((existing) => existing.id === incoming.id)
        ))]
        : params.resources;
    credentialLists.set(credentialListKey(params.scope, params.address, queryKey), Object.freeze({
        scope: params.scope,
        address: params.address,
        queryKey,
        status: 'ready',
        data: preserveUnchangedCredentialResources(current?.data ?? null, resources),
        nextCursor: params.nextCursor ?? null,
        viewer: current?.viewer && areProjectionsEquivalent(current.viewer, params.viewer)
            ? current.viewer
            : params.viewer,
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }));
    notify();
}

export function applyTeamCredentialResourcesFailure(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    queryKey?: string;
    error: ScopedSnapshotError;
}>): void {
    const queryKey = params.queryKey ?? '';
    const current = getTeamCredentialResourcesSnapshot(params.scope, params.address, queryKey);
    // An authoritative refusal withdraws the viewer decision as well as the
    // rows: continuing to offer management the Home has just denied would be
    // the one failure this projection exists to prevent.
    const withdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    const failed: TeamCredentialResourcesSnapshot = Object.freeze({
        scope: params.scope,
        address: params.address,
        queryKey,
        status: 'error',
        data: withdrawn ? null : current?.data ?? null,
        nextCursor: withdrawn ? null : current?.nextCursor ?? null,
        viewer: withdrawn ? null : current?.viewer ?? null,
        lastObservedAt: withdrawn ? null : current?.lastObservedAt ?? null,
        stale: !withdrawn && Boolean(current?.data),
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: params.error,
    });
    credentialLists.set(credentialListKey(params.scope, params.address, queryKey), failed);
    if (withdrawn) {
        // Authorization is Team-resource authority, not query authority. A
        // refusal on one filter therefore withdraws every retained variant.
        for (const [key, snapshot] of credentialLists) {
            if (key === credentialListKey(params.scope, params.address, queryKey)
                || !credentialSnapshotMatches(snapshot, params.scope, params.address)) continue;
            credentialLists.set(key, Object.freeze({
                ...snapshot,
                status: 'error',
                data: null,
                nextCursor: null,
                viewer: null,
                lastObservedAt: null,
                stale: false,
                reachability: reachabilityForScopedSnapshotError(params.error),
                error: params.error,
            }));
        }
    }
    notify();
}

export function beginTeamCredentialResourceCatalogLoad(
    scope: ServerAccountScope,
    address: TeamAddress,
    application?: ProviderBrokerApplicationBindingV1,
): void {
    const current = getTeamCredentialResourceCatalogSnapshot(scope, address, application);
    const status: ScopedSnapshotStatus = current?.data ? 'refreshing' : 'loading';
    if (current && current.status === status && current.error === null) return;
    credentialCatalogs.set(teamCredentialResourceCatalogKey(scope, address, application), Object.freeze({
        scope,
        address,
        ...(application ? { application } : {}),
        status,
        data: current?.data ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        selectionCurrent: current?.selectionCurrent ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
    notify();
}

export function applyTeamCredentialResourceCatalog(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    application?: ProviderBrokerApplicationBindingV1;
    resources: readonly TeamCredentialResourceCatalogEntryV1[];
    observedAt: number;
    current?: boolean;
}>): void {
    const current = getTeamCredentialResourceCatalogSnapshot(params.scope, params.address, params.application);
    credentialCatalogs.set(teamCredentialResourceCatalogKey(params.scope, params.address, params.application), Object.freeze({
        scope: params.scope,
        address: params.address,
        ...(params.application ? { application: params.application } : {}),
        status: 'ready',
        data: preserveUnchangedCredentialCatalog(current?.data ?? null, params.resources),
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        selectionCurrent: params.current !== false,
        reachability: 'reachable',
        error: null,
    }));
    notify();
}

export function applyTeamCredentialResourceCatalogFailure(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    application?: ProviderBrokerApplicationBindingV1;
    error: ScopedSnapshotError;
}>): void {
    const current = getTeamCredentialResourceCatalogSnapshot(params.scope, params.address, params.application);
    const withdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    credentialCatalogs.set(teamCredentialResourceCatalogKey(params.scope, params.address, params.application), Object.freeze({
        scope: params.scope,
        address: params.address,
        ...(params.application ? { application: params.application } : {}),
        status: 'error',
        data: withdrawn ? null : current?.data ?? null,
        lastObservedAt: withdrawn ? null : current?.lastObservedAt ?? null,
        stale: !withdrawn && Boolean(current?.data),
        // A transient read failure does not retract the last admitted picker choice.
        // Preserve withdrawal from a real Home loss, refusal, mutation or observer gap.
        selectionCurrent: params.error.kind === 'unknown' && params.error.retryable
            && current?.selectionCurrent === true,
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: params.error,
    }));
    notify();
}

export function invalidateTeamCredentialResourceCatalog(
    scope: ServerAccountScope,
    address: TeamAddress,
    application?: ProviderBrokerApplicationBindingV1,
    options?: Readonly<{ retainSelection: boolean }>,
): boolean {
    const changed = markTeamCredentialResourceCatalogStale(scope, address, application, options?.retainSelection === true);
    if (!changed) return false;
    notify();
    return true;
}

function markTeamCredentialResourceCatalogStale(
    scope: ServerAccountScope,
    address: TeamAddress,
    application?: ProviderBrokerApplicationBindingV1,
    retainSelection = false,
): boolean {
    const key = teamCredentialResourceCatalogKey(scope, address, application);
    const current = credentialCatalogs.get(key);
    if (!current || (current.stale && (retainSelection || !current.selectionCurrent))) return false;
    credentialCatalogs.set(key, Object.freeze({ ...current, stale: true,
        selectionCurrent: retainSelection && current.selectionCurrent }));
    return true;
}

export function invalidateTeamCredentialResourcesSnapshot(
    scope: ServerAccountScope,
    address: TeamAddress,
    queryKey = '',
): boolean {
    const key = credentialListKey(scope, address, queryKey);
    const current = credentialLists.get(key);
    if (!current || current.stale) return false;
    credentialLists.set(key, Object.freeze({ ...current, stale: true }));
    notify();
    return true;
}

export function invalidateTeamCredentialResourceSnapshot(
    scope: ServerAccountScope,
    address: TeamAddress,
    resourceId: string,
): boolean {
    const key = credentialResourceKey(scope, address, resourceId);
    const current = credentialResources.get(key);
    if (!current || current.stale) return false;
    credentialResources.set(key, Object.freeze({ ...current, stale: true }));
    notify();
    return true;
}

/**
 * Marks the Team's resource projection stale after a mutation answered.
 *
 * A create, update, audience change or delete changes rows this answer does not
 * describe — an audience change alters no field of the summary the caller holds
 * — so the one projection re-reads rather than each surface predicting a row.
 */
export function invalidateTeamCredentialResources(
    scope: ServerAccountScope,
    address: TeamAddress,
    resourceId?: string,
): boolean {
    let changed = false;
    for (const [key, current] of credentialLists) {
        if (current.stale || !credentialSnapshotMatches(current, scope, address)) continue;
        credentialLists.set(key, Object.freeze({ ...current, stale: true }));
        changed = true;
    }
    for (const [key, current] of credentialResources) {
        if (current.stale || !credentialSnapshotMatches(current, scope, address)) continue;
        if (resourceId !== undefined && current.resourceId !== resourceId) continue;
        credentialResources.set(key, Object.freeze({ ...current, stale: true }));
        changed = true;
    }
    for (const [key, current] of credentialCatalogs) {
        if ((current.stale && !current.selectionCurrent) || !credentialSnapshotMatches(current, scope, address)) continue;
        credentialCatalogs.set(key, Object.freeze({ ...current, stale: true, selectionCurrent: false }));
        changed = true;
    }
    if (changed) notify();
    return changed;
}

export function beginTeamGroupLoad(
    scope: ServerAccountScope,
    address: TeamAddress,
    groupId: string,
): void {
    const current = getTeamGroupSnapshot(scope, address, groupId);
    const status: ScopedSnapshotStatus = current?.data ? 'refreshing' : 'loading';
    if (current && current.status === status && current.error === null) return;
    groups.set(groupKey(scope, address, groupId), Object.freeze({
        scope,
        address,
        groupId,
        status,
        data: current?.data ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
    notify();
}

/**
 * Publishes one Group. Mutations answer with the row the viewer now sees, so a
 * successful edit, archive or restore publishes here and every surface holding
 * that Group observes the Home's own truth without a second read.
 */
export function applyTeamGroupProjection(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    group: TeamGroupV1;
    observedAt: number;
    current?: boolean;
}>): void {
    const current = getTeamGroupSnapshot(params.scope, params.address, params.group.id);
    const data = current?.data && areProjectionsEquivalent(current.data, params.group)
        ? current.data
        : params.group;
    groups.set(groupKey(params.scope, params.address, params.group.id), Object.freeze({
        scope: params.scope,
        address: params.address,
        groupId: params.group.id,
        status: 'ready',
        data,
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }));
    notify();
}

export function applyTeamGroupFailure(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    groupId: string;
    error: ScopedSnapshotError;
}>): void {
    const current = getTeamGroupSnapshot(params.scope, params.address, params.groupId);
    const withdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    groups.set(groupKey(params.scope, params.address, params.groupId), Object.freeze({
        scope: params.scope,
        address: params.address,
        groupId: params.groupId,
        status: 'error',
        data: withdrawn ? null : current?.data ?? null,
        lastObservedAt: withdrawn ? null : current?.lastObservedAt ?? null,
        stale: !withdrawn && Boolean(current?.data),
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: params.error,
    }));
    notify();
}

/**
 * Marks every Group projection for one Team stale after a Group mutation, so a
 * create or a membership change re-reads the one sequence instead of leaving a
 * list that no longer matches the Home.
 */
export function invalidateTeamGroupsForTeam(scope: ServerAccountScope, address: TeamAddress): boolean {
    const prefix = serverAccountScopedTeamKey(scope, address);
    let changed = false;
    for (const [key, snapshot] of groupLists) {
        if (!key.startsWith(prefix) || snapshot.stale) continue;
        groupLists.set(key, Object.freeze({ ...snapshot, stale: true }));
        changed = true;
    }
    for (const [key, snapshot] of groups) {
        if (!key.startsWith(prefix) || snapshot.stale) continue;
        groups.set(key, Object.freeze({ ...snapshot, stale: true }));
        changed = true;
    }
    if (changed) notify();
    return changed;
}

export function beginTeamLoad(scope: ServerAccountScope, address: TeamAddress): void {
    const current = getTeamSnapshot(scope, address);
    const status: ScopedSnapshotStatus = current?.data ? 'refreshing' : 'loading';
    if (current && current.status === status && current.error === null) return;
    teams.set(serverAccountScopedTeamKey(scope, address), Object.freeze({
        scope,
        address,
        status,
        data: current?.data ?? null,
        lastObservedAt: current?.lastObservedAt ?? null,
        stale: current?.stale ?? false,
        reachability: current?.reachability ?? 'unknown',
        error: null,
    }));
    notify();
}

export function applyTeamProjection(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    team: TeamSummaryV1;
    observedAt: number;
    current?: boolean;
}>): void {
    const current = getTeamSnapshot(params.scope, params.address);
    const data = current?.data && areTeamSummariesEquivalent(current.data, params.team)
        ? current.data
        : params.team;
    teams.set(serverAccountScopedTeamKey(params.scope, params.address), Object.freeze({
        scope: params.scope,
        address: params.address,
        status: 'ready',
        data,
        lastObservedAt: params.observedAt,
        stale: params.current === false,
        reachability: 'reachable',
        error: null,
    }));
    notify();
}

export function applyTeamFailure(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    error: ScopedSnapshotError;
}>): void {
    const current = getTeamSnapshot(params.scope, params.address);
    const withdrawn = isAuthoritativeScopedSnapshotRefusal(params.error);
    teams.set(serverAccountScopedTeamKey(params.scope, params.address), Object.freeze({
        scope: params.scope,
        address: params.address,
        status: 'error',
        data: withdrawn ? null : current?.data ?? null,
        lastObservedAt: withdrawn ? null : current?.lastObservedAt ?? null,
        stale: !withdrawn && Boolean(current?.data),
        reachability: reachabilityForScopedSnapshotError(params.error),
        error: params.error,
    }));
    notify();
}

/** Marks one exact directory query stale without touching sibling queries. */
export function invalidateTeamsDirectorySnapshot(
    scope: ServerAccountScope,
    queryKey: string,
): boolean {
    const key = directoryKey(scope, queryKey);
    const current = directories.get(key);
    if (!current || current.stale) return false;
    directories.set(key, Object.freeze({ ...current, stale: true }));
    notify();
    return true;
}

/** Marks one exact Team projection stale without touching the rest of its Home. */
export function invalidateTeamSnapshot(scope: ServerAccountScope, address: TeamAddress): boolean {
    const key = serverAccountScopedTeamKey(scope, address);
    const current = teams.get(key);
    if (!current || current.stale) return false;
    teams.set(key, Object.freeze({ ...current, stale: true }));
    notify();
    return true;
}

export function invalidateTeamGroupsSnapshot(
    scope: ServerAccountScope,
    address: TeamAddress,
    queryKey: string,
): boolean {
    const key = groupListKey(scope, address, queryKey);
    const current = groupLists.get(key);
    if (!current || current.stale) return false;
    groupLists.set(key, Object.freeze({ ...current, stale: true }));
    notify();
    return true;
}

export function invalidateTeamGroupSnapshot(
    scope: ServerAccountScope,
    address: TeamAddress,
    groupId: string,
): boolean {
    const key = groupKey(scope, address, groupId);
    const current = groups.get(key);
    if (!current || current.stale) return false;
    groups.set(key, Object.freeze({ ...current, stale: true }));
    notify();
    return true;
}

/**
 * The Account-change wake seam for one exact Home. It only marks rows stale, so
 * a coalesced or missed wake is harmless and no Team is refetched per ID.
 */
export function invalidateTeamsSnapshotsForServer(serverIdRaw: string): boolean {
    const serverId = serverIdRaw.trim();
    if (!serverId) return false;
    let changed = false;
    for (const [key, snapshot] of directories) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        directories.set(key, Object.freeze({ ...snapshot, stale: true }));
        changed = true;
    }
    for (const [key, snapshot] of teams) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        teams.set(key, Object.freeze({ ...snapshot, stale: true }));
        changed = true;
    }
    for (const [key, snapshot] of groupLists) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        groupLists.set(key, Object.freeze({ ...snapshot, stale: true }));
        changed = true;
    }
    for (const [key, snapshot] of groups) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        groups.set(key, Object.freeze({ ...snapshot, stale: true }));
        changed = true;
    }
    for (const [key, snapshot] of credentialLists) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        credentialLists.set(key, Object.freeze({ ...snapshot, stale: true }));
        changed = true;
    }
    for (const [key, snapshot] of credentialCatalogs) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        // A wake requests a reread, not a refusal. Keep the last admitted
        // picker choices while authority freshness is withdrawn; actual
        // mutation, observer-gap and unavailable/refused reads withdraw selection too.
        credentialCatalogs.set(key, Object.freeze({ ...snapshot, stale: true }));
        changed = true;
    }
    for (const [key, snapshot] of credentialResources) {
        if (snapshot.scope.serverId !== serverId || snapshot.stale) continue;
        credentialResources.set(key, Object.freeze({ ...snapshot, stale: true }));
        changed = true;
    }
    if (changed) notify();
    return changed;
}

/** Drops every Account's rows for one Home, for sign-out or credential change. */
export function clearTeamsSnapshotsForServer(serverIdRaw: string): void {
    const serverId = serverIdRaw.trim();
    if (!serverId) return;
    let changed = false;
    for (const [key, snapshot] of directories) {
        if (snapshot.scope.serverId !== serverId) continue;
        directories.delete(key);
        changed = true;
    }
    for (const [key, snapshot] of teams) {
        if (snapshot.scope.serverId !== serverId) continue;
        teams.delete(key);
        changed = true;
    }
    // Group rows are retired with the same credential-scope lifecycle as the
    // Teams that own them; leaving them behind would outlive their credential.
    for (const [key, snapshot] of groupLists) {
        if (snapshot.scope.serverId !== serverId) continue;
        groupLists.delete(key);
        changed = true;
    }
    for (const [key, snapshot] of groups) {
        if (snapshot.scope.serverId !== serverId) continue;
        groups.delete(key);
        changed = true;
    }
    // A resource projection carries an audience and a viewer decision made for
    // one credential; it must not outlive that credential either.
    for (const [key, snapshot] of credentialLists) {
        if (snapshot.scope.serverId !== serverId) continue;
        credentialLists.delete(key);
        changed = true;
    }
    for (const [key, snapshot] of credentialCatalogs) {
        if (snapshot.scope.serverId !== serverId) continue;
        credentialCatalogs.delete(key);
        changed = true;
    }
    for (const [key, snapshot] of credentialResources) {
        if (snapshot.scope.serverId !== serverId) continue;
        credentialResources.delete(key);
        changed = true;
    }
    if (changed) notify();
}

/** Test-only reset of the module-owned snapshot caches. */
export function resetTeamsSnapshotsForTests(): void {
    directories.clear();
    teams.clear();
    groupLists.clear();
    groups.clear();
    credentialLists.clear();
    credentialCatalogs.clear();
    credentialResources.clear();
    listeners.clear();
}
