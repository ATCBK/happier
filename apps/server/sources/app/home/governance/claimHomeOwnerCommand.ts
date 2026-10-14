import type { HOME_OWNER_CLAIM_COMMAND_ARGUMENT_V1, HomeOwnerClaimCommandOutputV1 as HomeOwnerClaimCommandOutputContractV1 } from '@happier-dev/protocol/home/governance/claim';

import type { HomeOwnerClaimResult } from "./ownerAssignment";

// Type-only binding to the protocol contract the hosting desktop's claim task consumes, so the
// argument and output cannot drift without a compile error and the entrypoint loads nothing.
export const CLAIM_HOME_OWNER_ARGUMENT: typeof HOME_OWNER_CLAIM_COMMAND_ARGUMENT_V1 = "--claim-home-owner";
export const RECOVER_LOST_OWNER_ARGUMENT = "--recover-lost-owner";
/**
 * Mints a one-time claim code for the app (plan `2026-09-26-home-owner-console` §3.5, D-5): on
 * demand, never at startup, so a live bearer only ever reaches the terminal of the operator who
 * asked for it. Same literal as the protocol's `HOME_CLAIM_CODE_COMMAND_ARGUMENT_V1`, kept local so
 * recognizing the command does not load the protocol package into the light boot path.
 */
export const PRINT_HOME_CLAIM_CODE_ARGUMENT = "--print-home-claim-code";

/**
 * What the operator says they are doing.
 *
 * Both intents run the identical transition and the identical checks: zero
 * active owners and an explicit active target. The flag exists so recovering a
 * Home that lost its owner is a deliberate statement rather than something an
 * operator discovers they did. Nothing about "was this Home ever owned" is
 * persisted, and this command does not invent that history to enforce more.
 */
export type HomeOwnerClaimIntentV1 = "initial_claim" | "lost_owner_recovery";

export type HomeOwnerClaimRequestV1 = Readonly<{
    targetAccountId: string;
    intent: HomeOwnerClaimIntentV1;
}>;

/**
 * The structured operator result. `homeServerIdentityId` is what lets an
 * operator confirm which Home they just changed when several are configured on
 * one machine.
 */
export type HomeOwnerClaimCommandOutputV1 = Readonly<{
    v: 1;
    command: "claim-home-owner";
    intent: HomeOwnerClaimIntentV1;
    homeServerIdentityId: string | null;
    targetAccountId: string;
    result: HomeOwnerClaimResult;
}>;

export type HomeOwnerClaimCommandRunV1 = Readonly<{
    output: HomeOwnerClaimCommandOutputV1 & HomeOwnerClaimCommandOutputContractV1;
    exitCode: 0 | 1;
}>;

/**
 * Reads `--name=value` and `--name value`, matching the argument style the
 * light runtime's existing one-shot commands already accept.
 */
function readArgumentValue(argv: readonly string[], name: string): string | null {
    const prefix = `${name}=`;
    const inlined = argv.find((argument) => argument.startsWith(prefix));
    if (inlined) return inlined.slice(prefix.length);
    const index = argv.indexOf(name);
    if (index < 0) return null;
    const next = argv[index + 1];
    return next === undefined || next.startsWith("--") ? "" : next;
}

/**
 * Recognizes the deployment-local claim command in a process argument list.
 *
 * Returns `null` when this invocation is not a claim, so the entrypoint falls
 * through to ordinary startup. A malformed claim throws instead: silently
 * booting a server because an operator mistyped the recovery flag would be the
 * worst possible outcome of a command whose whole purpose is explicitness.
 */
export function readHomeOwnerClaimRequest(argv: readonly string[]): HomeOwnerClaimRequestV1 | null {
    const rawTarget = readArgumentValue(argv, CLAIM_HOME_OWNER_ARGUMENT);
    const wantsRecovery = argv.includes(RECOVER_LOST_OWNER_ARGUMENT);
    if (rawTarget === null) {
        if (wantsRecovery) {
            throw new Error(`${RECOVER_LOST_OWNER_ARGUMENT} requires ${CLAIM_HOME_OWNER_ARGUMENT}=<accountId>`);
        }
        return null;
    }
    const targetAccountId = rawTarget.trim();
    if (targetAccountId.length === 0) {
        throw new Error(`${CLAIM_HOME_OWNER_ARGUMENT} requires an explicit Account ID`);
    }
    return { targetAccountId, intent: wantsRecovery ? "lost_owner_recovery" : "initial_claim" };
}

/**
 * Runs the claim against an already-opened database and reports the outcome.
 *
 * The decision itself belongs entirely to the shared zero-owner claim service:
 * this is a transport, not a second authority, and it holds no bearer, secret,
 * or role of its own. Availability comes from having deployment-level process
 * access, which is exactly why there is no HTTP equivalent.
 *
 * A non-`claimed` outcome exits nonzero so an operator's script cannot mistake
 * "this Home already has an owner" for success, while still printing the exact
 * structured reason.
 */
export async function runHomeOwnerClaimCommand(
    request: HomeOwnerClaimRequestV1,
): Promise<HomeOwnerClaimCommandRunV1> {
    // The database and identity owners load here rather than at module scope so
    // the light entrypoint can recognize this command without pulling Prisma
    // into its capability probe and ordinary boot path.
    const [{ claimHomeOwner }, { getOrCreateServerIdentityId, readCurrentServerIdentityId }] = await Promise.all([
        import("./ownerAssignment"),
        import("@/app/serverIdentity/serverIdentity"),
    ]);
    const result = await claimHomeOwner({ targetAccountId: request.targetAccountId });
    // On success the operator needs the Home identity to confirm what they
    // changed, so materialize it. A refused claim changed nothing and must not
    // leave a newly created identity behind as its only trace.
    const homeServerIdentityId = result.status === "claimed"
        ? await getOrCreateServerIdentityId()
        : await readCurrentServerIdentityId();
    return {
        output: {
            v: 1,
            command: "claim-home-owner",
            intent: request.intent,
            homeServerIdentityId,
            targetAccountId: request.targetAccountId,
            result,
        },
        exitCode: result.status === "claimed" ? 0 : 1,
    };
}

/** Whether this invocation asks for a claim code. */
export function readPrintHomeClaimCodeRequest(argv: readonly string[]): boolean {
    return argv.includes(PRINT_HOME_CLAIM_CODE_ARGUMENT);
}

export type PrintHomeClaimCodeOutputV1 = Readonly<{
    v: 1;
    command: "print-home-claim-code";
    result:
        | Readonly<{ status: "minted"; code: string; expiresAt: string }>
        | Readonly<{ status: "already_owned" }>;
}>;

/**
 * Mints the code against an already-opened database. The code is printed once, grouped for
 * reading, and never logged; an owned Home gets no code and a nonzero exit.
 */
export async function runPrintHomeClaimCodeCommand(): Promise<Readonly<{ output: PrintHomeClaimCodeOutputV1; exitCode: 0 | 1 }>> {
    const [{ mintHomeClaimCode }, { formatHomeClaimCodeV1 }] = await Promise.all([
        import("./homeClaimCode"),
        import("@happier-dev/protocol"),
    ]);
    const minted = await mintHomeClaimCode();
    if (minted.status !== "minted") {
        return { output: { v: 1, command: "print-home-claim-code", result: { status: "already_owned" } }, exitCode: 1 };
    }
    return {
        output: {
            v: 1,
            command: "print-home-claim-code",
            result: {
                status: "minted",
                code: formatHomeClaimCodeV1(minted.code),
                expiresAt: new Date(minted.expiresAt).toISOString(),
            },
        },
        exitCode: 0,
    };
}
