import type { Context } from "@/context";
import type { GitHubProfile } from "@/app/auth/providers/github/types";
import type { PreparedIdentityConnection } from "@/app/auth/providers/identityProviders/types";

export async function prepareGitHubIdentityConnection(params: {
    ctx: Context;
    profile: unknown;
    accessToken: string;
    preferredUsername?: string | null;
    usernamePolicyEnv?: NodeJS.ProcessEnv;
    transferFromAccountId?: string;
}): Promise<PreparedIdentityConnection> {
    // Lazy import to avoid provider-registry import cycles during server startup/tests.
    const { prepareGithubConnect } = await import("./githubConnect");
    return await prepareGithubConnect(
        params.ctx,
        params.profile as GitHubProfile,
        params.accessToken,
        { preferredUsername: params.preferredUsername, transferFromAccountId: params.transferFromAccountId, usernamePolicyEnv: params.usernamePolicyEnv },
    );
}

export async function connectGitHubIdentity(params: {
    ctx: Context;
    profile: unknown;
    accessToken: string;
    preferredUsername?: string | null;
    usernamePolicyEnv?: NodeJS.ProcessEnv;
    transferFromAccountId?: string;
}): Promise<void> {
    const prepared = await prepareGitHubIdentityConnection(params);
    const { inTx } = await import("@/storage/inTx");
    await inTx(prepared.connectInTx, { isolationLevel: "Serializable" /* Identity transfer and fill-if-empty Account presentation depend on the observed link and Account. */ });
}

export async function disconnectGitHubIdentity(ctx: Context): Promise<void> {
    // Lazy import to avoid provider-registry import cycles during server startup/tests.
    const { githubDisconnect } = await import("./githubDisconnect");
    await githubDisconnect(ctx);
}
