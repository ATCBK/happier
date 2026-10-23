import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * The owner's deliberate move of one historical (layout-0) Session to the
 * canonical owner/shared tuple, so the people and links it is shared with can
 * read its shared projection (PA-L2: "Reachable layout-0 Sessions migrate
 * through the canonical owner/tuple CAS before sharing or other non-owner
 * projection"). The one tuple owner performs the split through the exact
 * Home/Account authority; an already-migrated Session commits nothing.
 */
export async function migrateSessionForSharing(input: Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    isCurrent: () => boolean;
}>): Promise<void> {
    const { sync } = await import('@/sync/sync');
    await sync.migrateSessionMetadataOwnerLayout(input.sessionId, {
        serverId: input.scope.serverId,
        accountLifetime: { scope: input.scope, isCurrent: input.isCurrent },
    });
}
