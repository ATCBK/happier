import {
    RunnerConsentDisplayFactsV1Schema,
    type RunnerConsentDisplayFactsV1,
} from "@happier-dev/protocol/ephemeralRunner/review";

import {
    ACCOUNT_DISPLAY_PROFILE_SELECT,
    projectAccountDisplayProfileV1,
    resolveAccountDisplayLabelV1,
} from "@/app/account/profile/accountDisplayProfile";
import { resolveAuthPolicyFromEnv } from "@/app/auth/authPolicy";
import { resolveJoinScreenHomeDisplayName } from "@/app/teams/invitations/joinScreenHome";
import type { Tx } from "@/storage/inTx";

/**
 * Reads the three canonical presentation owners inside the caller's existing
 * Account/currentness transaction. These values are display-only: routing and
 * authorization continue to use the exact activation and Team-resource ids.
 */
export async function readRunnerConsentDisplayFactsInTx(input: Readonly<{
    tx: Tx;
    homeServerIdentityId: string;
    creatorAccountId: string;
    teamId: string;
}>): Promise<RunnerConsentDisplayFactsV1 | null> {
    const [account, team] = await Promise.all([
        input.tx.account.findUnique({
            where: { id: input.creatorAccountId },
            select: ACCOUNT_DISPLAY_PROFILE_SELECT,
        }),
        input.tx.team.findUnique({
            where: { id: input.teamId },
            select: { name: true },
        }),
    ]);
    if (!account || !team) return null;

    const profile = projectAccountDisplayProfileV1(account);
    const requesterName = resolveAccountDisplayLabelV1(profile) ?? "Happier member";
    const homeName = resolveAuthPolicyFromEnv(process.env).accountServicePresentation?.displayName
        ?? resolveJoinScreenHomeDisplayName(process.env)
        ?? "Happier Home";

    const parsed = RunnerConsentDisplayFactsV1Schema.safeParse({
        v: 1,
        homeId: input.homeServerIdentityId,
        homeName,
        requesterId: input.creatorAccountId,
        requesterName,
        teamId: input.teamId,
        teamName: team.name,
    });
    return parsed.success ? parsed.data : null;
}
