import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type MountedDiscussionChangeWatch = Readonly<{
    dispose(): void;
}>;

type ActiveWatch = Readonly<{
    scope: ServerAccountScope;
    address: Readonly<{ serverId: string }>;
    onInvalidated(discussionIds: readonly string[], revisions: ReadonlyMap<string, number>): void;
    includeDocSourceChanges?: () => boolean;
}>;

const activeWatches = new Set<ActiveWatch>();

/**
 * Observe the incumbent AccountChange catch-up for one mounted Discussion
 * surface. This opens no socket and owns no cursor or cached data: it only asks
 * the mounted repository/controller to reread canonical HTTP state.
 */
export function watchMountedDiscussions(input: Readonly<{
    scope: ServerAccountScope;
    address: Readonly<{ serverId: string }>;
    onInvalidated(discussionIds: readonly string[], revisions: ReadonlyMap<string, number>): void;
    includeDocSourceChanges?: () => boolean;
}>): MountedDiscussionChangeWatch {
    const watch: ActiveWatch = Object.freeze({
        scope: Object.freeze({ ...input.scope }),
        address: Object.freeze({ ...input.address }),
        onInvalidated: input.onInvalidated,
        includeDocSourceChanges: input.includeDocSourceChanges,
    });
    activeWatches.add(watch);
    let disposed = false;
    return Object.freeze({
        dispose(): void {
            if (disposed) return;
            disposed = true;
            activeWatches.delete(watch);
        },
    });
}

/**
 * Called by the one changes-page application path before checkpointing. Hints
 * are deliberately ignored for correctness because resource changes coalesce.
 */
export function publishMountedDiscussionChanges(input: Readonly<{
    serverId: string;
    accountId: string;
    changes: readonly ApiChangeEntry[];
}>): void {
    if (activeWatches.size === 0) return;
    const revisions = new Map<string, number>();
    for (const change of input.changes) {
        if (change.kind === 'discussion') revisions.set(change.entityId, Math.max(revisions.get(change.entityId) ?? 0, change.cursor));
    }
    const discussionIds = [...revisions.keys()];
    const discussionChanged = discussionIds.length > 0;
    const docChanged = input.changes.some(change => change.kind === 'artifact');
    if (!discussionChanged && !docChanged) return;

    for (const watch of [...activeWatches]) {
        if (
            input.accountId !== watch.scope.accountId
            || !areServerProfileIdentifiersEquivalent(input.serverId, watch.address.serverId)
        ) {
            continue;
        }
        if (!discussionChanged && !(docChanged && watch.includeDocSourceChanges?.())) continue;
        try {
            watch.onInvalidated(discussionIds, revisions);
        } catch {
            // A presentation refresh cannot suppress sibling observers or the
            // AccountChange owner's own canonical materialization/checkpoint.
        }
    }
}
