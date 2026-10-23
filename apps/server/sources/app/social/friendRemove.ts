import { Context } from "@/context";
import { buildUserProfile, describeIdentityPresentation, toSocialIdentities, UserProfile } from "./type";
import { inTx } from "@/storage/inTx";
import { relationshipSet } from "./relationshipSet";
import { relationshipGet } from "./relationshipGet";
import { RelationshipStatus } from "@/storage/prisma";
import { acquireAccountChangePublicationLocksInTx, markAccountChanged, markAccountsChanged } from "@/app/changes/markAccountChanged";

export async function friendRemove(ctx: Context, uid: string): Promise<UserProfile | null> {
    // Share friendAdd's complete bilateral admission before either state is read.
    return await inTx(async (tx) => {
        await acquireAccountChangePublicationLocksInTx(tx, [ctx.uid, uid], { includeSingleAccount: true, intent: 'serializing' });
        // Read current user objects
        const currentUser = await tx.account.findUnique({
            where: { id: ctx.uid },
            select: { id: true }
        });
        const targetUser = await tx.account.findUnique({
            where: { id: uid },
            include: {
                AccountIdentity: {
                    select: { provider: true, providerLogin: true, profile: true, showOnProfile: true },
                    orderBy: { provider: "asc" },
                },
            },
        });
        if (!currentUser || !targetUser) {
            return null;
        }
        const identities = toSocialIdentities(targetUser.AccountIdentity);
        const presentation = await describeIdentityPresentation(identities, tx);

        // Read relationship status
        const currentUserRelationship = await relationshipGet(tx, currentUser.id, targetUser.id);
        const targetUserRelationship = await relationshipGet(tx, targetUser.id, currentUser.id);

        // If status is requested, set it to rejected
        if (currentUserRelationship === RelationshipStatus.requested) {
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.rejected);
            await markAccountChanged(tx, { accountId: currentUser.id, kind: 'friends', entityId: 'self' });
            return buildUserProfile(targetUser as any, RelationshipStatus.rejected, identities, presentation);
        }

        // If they are friends, removing should fully clear the relationship.
        if (currentUserRelationship === RelationshipStatus.friend) {
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.none);
            await relationshipSet(tx, targetUser.id, currentUser.id, RelationshipStatus.none);
            await markAccountsChanged(tx, { accountIds: [currentUser.id, targetUser.id], kind: 'friends', entityId: 'self' });
            return buildUserProfile(targetUser as any, RelationshipStatus.none, identities, presentation);
        }

        // If status is pending, set it to none
        if (currentUserRelationship === RelationshipStatus.pending) {
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.none);
            let targetChanged = false;
            if (targetUserRelationship !== RelationshipStatus.rejected) {
                await relationshipSet(tx, targetUser.id, currentUser.id, RelationshipStatus.none);
                targetChanged = true;
            }
            await markAccountsChanged(tx, { accountIds: targetChanged ? [currentUser.id, targetUser.id] : [currentUser.id], kind: 'friends', entityId: 'self' });
            return buildUserProfile(targetUser as any, RelationshipStatus.none, identities, presentation);
        }

        // Return the target user profile with status none
        return buildUserProfile(targetUser as any, currentUserRelationship, identities, presentation);
    }, { isolationLevel: "ReadCommitted" });
}
