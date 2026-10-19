import { Context } from "@/context";
import { FeedBody } from "./types";
import { afterTx, Tx } from "@/storage/inTx";
import { eventRouter, buildNewFeedPostUpdate } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { enqueueAccountChangePublication, markAccountChanged } from "@/app/changes/markAccountChanged";

/**
 * Add a post to user's feed.
 * If repeatKey is provided and exists, the post will be updated in-place.
 * Otherwise, a new post is created with an incremented counter. Counter and
 * item insertion run in terminal publication, after the caller's domain work.
 */
export async function feedPost(
    tx: Tx,
    ctx: Context,
    body: FeedBody,
    repeatKey?: string | null
): Promise<void> {


    // Delete existing items with the same repeatKey
    if (repeatKey) {
        await tx.userFeedItem.deleteMany({
            where: {
                userId: ctx.uid,
                repeatKey: repeatKey
            }
        });
    }

    enqueueAccountChangePublication(tx, [ctx.uid], async tx => {
        // Allocate the Account-owned counter after the complete publication audience is locked.
        const user = await tx.account.update({
            where: { id: ctx.uid },
            select: { feedSeq: true },
            data: { feedSeq: { increment: 1 } }
        });

        const item = await tx.userFeedItem.create({
            data: {
                counter: user.feedSeq,
                userId: ctx.uid,
                repeatKey,
                body,
            }
        });

        const result = {
            ...item,
            createdAt: item.createdAt.getTime(),
            cursor: '0-' + item.counter.toString(10)
        };

        const cursor = await markAccountChanged(tx, { accountId: ctx.uid, kind: 'feed', entityId: 'self', hint: { cursor: result.cursor } });

        afterTx(tx, () => {
            eventRouter.emitUpdate({
                userId: ctx.uid,
                payload: buildNewFeedPostUpdate(result, cursor.resolveCursor(), randomKeyNaked(12)),
                recipientFilter: { type: 'user-scoped-only' }
            });
        });
    });
}
