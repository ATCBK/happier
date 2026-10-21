import { resolveProfileLogin } from "./resolveProfileLogin";
import { unlinkIdentity } from "../accountIdentityLifecycle";
import { db } from "@/storage/db";
import { Context } from "@/context";
import { log } from "@/utils/logging/log";

/**
 * Disconnects a GitHub account from a user profile.
 *
 * Flow:
 * 1. Check if user has GitHub connected - early exit if not
 * 2. In transaction: unlink GitHub and clear only an eligible automatic matching username (keeps avatar)
 * 3. Send socket update after transaction completes
 *
 * @param ctx - Request context containing user ID
 */
export async function githubDisconnect(ctx: Context): Promise<void> {
    const userId = ctx.uid;

    // Step 1: Check if user has GitHub connection
    const identity = await db.accountIdentity.findFirst({
        where: { accountId: userId, provider: "github" },
        select: { providerUserId: true, providerLogin: true, profile: true },
    });

    // Early exit if no GitHub connection
    if (!identity) {
        log({ module: 'github-disconnect' }, `User ${userId} has no GitHub account connected`);
        return;
    }

    const githubLogin = resolveProfileLogin({ profile: identity.profile, providerLogin: identity.providerLogin });

    log({ module: 'github-disconnect' }, `Disconnecting GitHub account ${identity.providerUserId} from user ${userId}`);

    await unlinkIdentity({ accountId: userId, provider: "github", clearMatchingUsername: githubLogin });

    log({ module: 'github-disconnect' }, `GitHub account ${identity.providerUserId} disconnected successfully from user ${userId}`);
}
