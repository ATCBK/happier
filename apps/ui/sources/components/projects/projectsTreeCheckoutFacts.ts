import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import type { StorageState } from '@/sync/store/types';
import { resolveDisplayIdentityForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    readSessionRuntimePresentationFreshnessExpirations,
} from '@/sync/domains/session/attention/runtimePresentation';
import { resolveInboxItemAttentionV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import {
    readRealmQualifiedMobileSurface,
    resolveProjectMobileSurfaceStorageKey,
} from '@/sync/domains/settings/mobileSurfacePersistence';
import { buildWorkspaceCacheKey, normalizeWorkspaceRootPath } from '@/sync/domains/workspaces/workspaceScope';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';

import { projectsTreeCheckoutKey, type ProjectsTreeCheckoutFacts } from './projectsTreeRows';

export type ProjectsTreeCheckoutFactsState = Pick<StorageState,
    'sessions' | 'sessionListRowsByServerId' | 'sessionListRenderableDelta' | 'machines' | 'machineListByServerId' | 'profileScope' | 'getWorkspaceScmSnapshot'
> & Readonly<{ localSettings: Pick<LocalSettings, 'projectLastMobileSurfaceByWorkspaceRefId'> }>;

export type ProjectsTreeCheckoutFactsSelector = {
    (state: ProjectsTreeCheckoutFactsState, nowMs: number): ReadonlyMap<string, ProjectsTreeCheckoutFacts>;
    getNextWakeAtMs(): number | null;
};

function checkoutKey(ref: WorkspaceRefV1): string {
    return projectsTreeCheckoutKey({ refId: ref.id, workspaceAddress: workspaceAddressFromRefV1(ref) });
}

function readScmFacts(snapshot: ScmWorkingSnapshot | null, rootPath: string) {
    if (!snapshot?.repo.isRepo) return { branch: null, isWorktree: snapshot ? false : null };
    const worktree = snapshot.repo.worktrees?.find(row => normalizeWorkspaceRootPath(row.path) === normalizeWorkspaceRootPath(rootPath));
    return {
        branch: snapshot.branch.head?.trim() || null,
        isWorktree: typeof worktree?.isMain === 'boolean' ? !worktree.isMain : null,
    };
}

function sameFacts(left: ProjectsTreeCheckoutFacts | undefined, right: ProjectsTreeCheckoutFacts): boolean {
    return left !== undefined && left.branch === right.branch && left.isWorktree === right.isWorktree
        && left.attention === right.attention && left.newFromSession === right.newFromSession;
}

/**
 * The tree buys summaries, not Session records or transcript detail. Exact Session placement uses
 * the existing target resolver and observed SCM root; runtime classification stays in awareness.
 * Unchanged summaries keep their identities even when a title, seq or fetchedAt changes.
 */
export function createProjectsTreeCheckoutFactsSelector(refs: readonly WorkspaceRefV1[]): ProjectsTreeCheckoutFactsSelector {
    let previous: ReadonlyMap<string, ProjectsTreeCheckoutFacts> = new Map();
    let previousState: ProjectsTreeCheckoutFactsState | null = null;
    let previousNowMs: number | null = null;
    let previousRevision: number | null = null;
    let nextWakeAtMs: number | null = null;
    const refScopes = new Set(refs.map(ref => buildWorkspaceCacheKey(ref)));
    const serverIds = new Set(refs.map(ref => ref.serverId));
    // Structural membership only. Status is recomputed from canonical rows for the affected keys.
    const placementByAddress = new Map<string, { serverId: string; sessionId: string; machineId: string; rootPath: string; scopeKey: string }>();
    const membersByScope = new Map<string, Set<string>>();
    const wakeAtByScope = new Map<string, number>();

    const removePlacement = (address: string, affected: Set<string>) => {
        const old = placementByAddress.get(address);
        if (!old) return;
        const members = membersByScope.get(old.scopeKey);
        members?.delete(address);
        if (members?.size === 0) membersByScope.delete(old.scopeKey);
        placementByAddress.delete(address);
        affected.add(old.scopeKey);
    };

    const place = (state: ProjectsTreeCheckoutFactsState, serverId: string, sessionId: string, affected: Set<string>) => {
        const address = JSON.stringify([serverId, sessionId]);
        removePlacement(address, affected);
        const row = state.sessionListRowsByServerId[serverId]?.[sessionId];
        if (!row) return;
        const direct = state.sessions[sessionId];
        const metadata = direct && areServerProfileIdentifiersEquivalent(direct.serverId, serverId)
            ? readSessionOwnerMetadataView(direct) : row.metadata;
        if (readSessionDirectoryKind(metadata) === 'managed') return;
        const identity = resolveDisplayIdentityForSessionFromState({
            state, serverId, sessionId, metadata, preferProvidedMetadata: true,
        });
        if (!identity.machineId || !identity.basePath) return;
        const location = resolveSessionWorkspaceRootForMachine({
            metadata, machineId: identity.machineId, candidatePath: identity.basePath,
        });
        const rootPath = normalizeWorkspaceRootPath(location.machinePath, metadata?.homeDir ?? undefined);
        if (!rootPath) return;
        const target = { serverId, machineId: identity.machineId, rootPath };
        const snapshot = state.getWorkspaceScmSnapshot(target);
        const scopeKey = buildWorkspaceCacheKey({ ...target,
            rootPath: snapshot?.repo.isRepo && snapshot.repo.rootPath ? snapshot.repo.rootPath : rootPath });
        if (!refScopes.has(scopeKey)) return;
        placementByAddress.set(address, { serverId, sessionId, machineId: identity.machineId, rootPath, scopeKey });
        let members = membersByScope.get(scopeKey);
        if (!members) membersByScope.set(scopeKey, members = new Set());
        members.add(address);
        affected.add(scopeKey);
    };

    const select = (state: ProjectsTreeCheckoutFactsState, nowMs: number): ReadonlyMap<string, ProjectsTreeCheckoutFacts> => {
        if (previousRevision === state.sessionListRenderableDelta.revision && previousNowMs === nowMs
            && previousState?.sessionListRowsByServerId === state.sessionListRowsByServerId
            && previousState.sessions === state.sessions && previousState.machines === state.machines
            && previousState.machineListByServerId === state.machineListByServerId
            && previousState.profileScope === state.profileScope
            && previousState.getWorkspaceScmSnapshot === state.getWorkspaceScmSnapshot
            && previousState.localSettings === state.localSettings) return previous;
        const affected = new Set<string>();
        const delta = state.sessionListRenderableDelta;
        const rowsChanged = previousState?.sessionListRowsByServerId !== state.sessionListRowsByServerId
            || previousState?.sessions !== state.sessions;
        const canApplyDelta = previousRevision !== null && delta.revision === previousRevision + 1;
        const rebuild = previousState === null || previousState.machines !== state.machines
            || previousState.machineListByServerId !== state.machineListByServerId
            || previousState.profileScope !== state.profileScope
            || previousState.getWorkspaceScmSnapshot !== state.getWorkspaceScmSnapshot
            || previousNowMs !== null && nowMs < previousNowMs
            || canApplyDelta && delta.rebuiltSessionListIndex
            || rowsChanged && !canApplyDelta;
        if (rebuild) {
            placementByAddress.clear();
            membersByScope.clear();
            wakeAtByScope.clear();
            for (const scope of refScopes) affected.add(scope);
            for (const serverId of serverIds) {
                for (const sessionId of Object.keys(state.sessionListRowsByServerId[serverId] ?? {})) place(state, serverId, sessionId, affected);
            }
        } else if (canApplyDelta) {
            for (const serverId of serverIds) {
                for (const sessionId of delta.removedSessionIds) place(state, serverId, sessionId, affected);
                for (const sessionId of delta.changedSessionIds) place(state, serverId, sessionId, affected);
            }
        }
        for (const [scope, wakeAt] of wakeAtByScope) if (wakeAt <= nowMs) affected.add(scope);
        const next = new Map<string, ProjectsTreeCheckoutFacts>();
        let unchanged = previous.size === refs.length;
        for (const ref of refs) {
            const key = checkoutKey(ref);
            const scope = buildWorkspaceCacheKey(ref);
            const old = previous.get(key);
            let attention = old?.attention ?? null;
            let memberSnapshot: ScmWorkingSnapshot | null = null;
            if (affected.has(scope)) {
                attention = null;
                wakeAtByScope.delete(scope);
                for (const address of membersByScope.get(scope) ?? []) {
                    const placement = placementByAddress.get(address)!;
                    const row = state.sessionListRowsByServerId[placement.serverId]?.[placement.sessionId];
                    if (!row) continue;
                    const runtimeInput = { ...row, hasPendingUserMessages: (row.pendingCount ?? 0) > 0, nowMs };
                    const status = resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(
                        row.serverId === placement.serverId ? row : { ...row, serverId: placement.serverId }, nowMs,
                    ) });
                    const memberAttention = status.attentionType && resolveInboxItemAttentionV1(status.attentionType).interrupt
                        ? 'needs-you' : status.bucket === 'working' ? 'working' : null;
                    if (memberAttention === 'needs-you' || attention !== 'needs-you' && memberAttention === 'working') attention = memberAttention;
                    const snapshot = state.getWorkspaceScmSnapshot(placement);
                    if (snapshot && (!memberSnapshot || snapshot.fetchedAt > memberSnapshot.fetchedAt)) memberSnapshot = snapshot;
                    for (const expiry of readSessionRuntimePresentationFreshnessExpirations(runtimeInput, nowMs)) {
                        wakeAtByScope.set(scope, Math.min(wakeAtByScope.get(scope) ?? Infinity, expiry));
                    }
                }
            }
            const workspaceSnapshot = state.getWorkspaceScmSnapshot(ref);
            const snapshot = !workspaceSnapshot || (memberSnapshot && memberSnapshot.fetchedAt > workspaceSnapshot.fetchedAt)
                ? memberSnapshot : workspaceSnapshot;
            const surfaceKey = resolveProjectMobileSurfaceStorageKey({
                workspaceRefs: refs, workspaceRefId: ref.id, activeScope: state.profileScope,
                activeServerId: state.profileScope?.serverId, targetServerId: ref.serverId,
            });
            const facts: ProjectsTreeCheckoutFacts = {
                ...(snapshot || affected.has(scope) ? readScmFacts(snapshot, ref.rootPath)
                    : { branch: old?.branch ?? null, isWorktree: old?.isWorktree ?? null }),
                attention,
                newFromSession: (membersByScope.get(scope)?.size ?? 0) > 0 && surfaceKey !== null && ref.lastOpenedAtMs == null
                    && readRealmQualifiedMobileSurface(state.localSettings.projectLastMobileSurfaceByWorkspaceRefId, surfaceKey) === null,
            };
            const stable = sameFacts(old, facts) ? old! : facts;
            next.set(key, stable);
            if (stable !== old) unchanged = false;
        }
        if (!unchanged) previous = next;
        nextWakeAtMs = null;
        for (const wakeAt of wakeAtByScope.values()) nextWakeAtMs = Math.min(nextWakeAtMs ?? Infinity, wakeAt);
        previousState = { sessions: state.sessions, sessionListRowsByServerId: state.sessionListRowsByServerId,
            sessionListRenderableDelta: state.sessionListRenderableDelta, machines: state.machines,
            machineListByServerId: state.machineListByServerId, profileScope: state.profileScope,
            getWorkspaceScmSnapshot: state.getWorkspaceScmSnapshot, localSettings: state.localSettings };
        previousNowMs = nowMs;
        previousRevision = delta.revision;
        return previous;
    };
    return Object.assign(select, { getNextWakeAtMs: () => nextWakeAtMs });
}
