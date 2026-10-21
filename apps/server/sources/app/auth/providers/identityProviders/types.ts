import type { Context } from "@/context";
import type { AuthPolicy } from "@/app/auth/authPolicy";
import type { LoginEligibilityResult } from "@/app/auth/loginEligibilityResult";
import type { Tx } from "@/storage/inTx";
import type { NormalizedVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';

export type PreparedIdentityConnection = Readonly<{
    connectInTx: (tx: Tx) => Promise<void>;
    /** Provider-classified mailbox proof; only the fresh-Account transaction persists it. */
    verifiedMailbox?: NormalizedVerifiedEmail;
}>;

export type IdentityProvider = Readonly<{
    id: string;
    connect: (params: {
        ctx: Context;
        profile: unknown;
        accessToken: string;
        refreshToken?: string;
        preferredUsername?: string | null;
        usernamePolicyEnv?: NodeJS.ProcessEnv;
        transferFromAccountId?: string;
    }) => Promise<void>;
    prepareConnect: (params: {
        ctx: Context;
        profile: unknown;
        accessToken: string;
        refreshToken?: string;
        preferredUsername?: string | null;
        usernamePolicyEnv?: NodeJS.ProcessEnv;
        transferFromAccountId?: string;
    }) => Promise<PreparedIdentityConnection>;
    disconnect: (params: { ctx: Context }) => Promise<void>;
    enforceLoginEligibility?: (params: {
        accountId: string;
        env: NodeJS.ProcessEnv;
        policy: AuthPolicy;
        now?: Date;
    }) => Promise<LoginEligibilityResult>;
    extractSocialProfile?: (params: { profile: unknown }) => { bio: string | null; suggestedUsername: string | null };
    extractLinkedProvider?: (params: {
        profile: unknown;
        providerLogin: string | null;
    }) => { displayName: string | null; avatarUrl: string | null; profileUrl: string | null };
    extractProfileBadge?: (params: {
        profile: unknown;
        providerLogin: string | null;
    }) => { label: string; url: string } | null;
}>;
