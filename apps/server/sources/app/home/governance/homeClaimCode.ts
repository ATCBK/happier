import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { encodeHomeClaimCodeV1, normalizeHomeClaimCodeV1 } from '@happier-dev/protocol/home/governance/claim';

import { inTx, type Tx } from "@/storage/inTx";

import { countActiveHomeOwnersInTx } from "./homeCapabilities";
import { claimHomeOwnerInTx } from "./ownerAssignment";
import { acquireHomeGovernanceAdmissionInTx } from "./governanceChanges";

/**
 * The one-time Home claim code (plan `2026-09-26-home-owner-console` §3.5, decision A(b), AM-1,
 * D-5): an adapter onto the one zero-owner transition, `claimHomeOwnerInTx`, never a second way to
 * assign an owner.
 *
 * `happier-server --print-home-claim-code` mints it on demand from a shell with database access,
 * so holding it proves the same deployment-level access `--claim-home-owner` requires. Only its
 * SHA-256 is stored, in the existing key/value owner; printing a new code replaces the previous one.
 */
export const HOME_CLAIM_CODE_CACHE_KEY = "home.owner-claim-code.v1";

/**
 * Protected resource: a live bearer printed into a terminal whose scrollback or shared screen can
 * outlive the operator's attention. Fifteen minutes is the time to open the app and paste it; the
 * expiry is printed with the code and a refusal says to print a new one.
 */
export const HOME_CLAIM_CODE_LIFETIME_MS = 15 * 60 * 1000;

const CLAIM_CODE_BYTES = 32;

type StoredClaimCode = Readonly<{ v: 1; hash: string; expiresAt: number }>;

function hashCode(canonical: string): string {
    return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function readStoredClaimCode(value: string): StoredClaimCode | null {
    try {
        const parsed: unknown = JSON.parse(value);
        if (parsed === null || typeof parsed !== "object") return null;
        const record = parsed as Record<string, unknown>;
        if (record.v !== 1 || typeof record.hash !== "string" || !/^[0-9a-f]{64}$/.test(record.hash)) return null;
        if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return null;
        return { v: 1, hash: record.hash, expiresAt: record.expiresAt };
    } catch {
        return null;
    }
}

export type HomeClaimCodeMintResult =
    | Readonly<{ status: "minted"; code: string; expiresAt: number }>
    | Readonly<{ status: "already_owned" }>;

/** Mints a code for an ownerless Home, replacing any earlier one. A Home with an owner gets none. */
export async function mintHomeClaimCode(
    input: Readonly<{ now?: number }> = {},
): Promise<HomeClaimCodeMintResult> {
    const now = input.now ?? Date.now();
    return await inTx(async (tx) => {
        if (await countActiveHomeOwnersInTx(tx) > 0) return { status: "already_owned" as const };
        const code = encodeHomeClaimCodeV1(randomBytes(CLAIM_CODE_BYTES));
        const expiresAt = now + HOME_CLAIM_CODE_LIFETIME_MS;
        const value = JSON.stringify({ v: 1, hash: hashCode(code), expiresAt } satisfies StoredClaimCode);
        await tx.simpleCache.upsert({
            where: { key: HOME_CLAIM_CODE_CACHE_KEY },
            update: { value },
            create: { key: HOME_CLAIM_CODE_CACHE_KEY, value },
        });
        return { status: "minted" as const, code, expiresAt };
    }, { isolationLevel: "Serializable" });
}

export type HomeClaimCodeRedeemResult =
    | Readonly<{ status: "claimed" }>
    | Readonly<{ status: "refused" }>;

/** Thrown to roll back a spent code when the claim itself is refused, so the code survives. */
class ClaimRefusedAfterSpend extends Error {}

async function redeemInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; code: string; now: number }>,
): Promise<HomeClaimCodeRedeemResult> {
    if (await countActiveHomeOwnersInTx(tx) > 0) return { status: "refused" };
    const row = await tx.simpleCache.findUnique({ where: { key: HOME_CLAIM_CODE_CACHE_KEY }, select: { value: true } });
    if (!row) return { status: "refused" };
    const stored = readStoredClaimCode(row.value);
    if (!stored || input.now >= stored.expiresAt) {
        // An expired or unreadable code can never be used; remove it (only if nobody replaced it).
        await tx.simpleCache.deleteMany({ where: { key: HOME_CLAIM_CODE_CACHE_KEY, value: row.value } });
        return { status: "refused" };
    }
    const canonical = normalizeHomeClaimCodeV1(input.code);
    // Hash whatever was sent so the comparison takes the same time for malformed and wrong codes.
    const submitted = Buffer.from(hashCode(canonical ?? input.code), "hex");
    if (!canonical || !timingSafeEqual(submitted, Buffer.from(stored.hash, "hex"))) return { status: "refused" };

    await acquireHomeGovernanceAdmissionInTx(tx, { accountIds: [input.accountId], intent: "exclusive" });
    // Spend the code first, conditionally, so two concurrent redemptions cannot both use it.
    const spent = await tx.simpleCache.deleteMany({ where: { key: HOME_CLAIM_CODE_CACHE_KEY, value: row.value } });
    if (spent.count !== 1) return { status: "refused" };
    const claim = await claimHomeOwnerInTx(tx, { targetAccountId: input.accountId, via: "claim_code" });
    if (claim.status !== "claimed") throw new ClaimRefusedAfterSpend();
    return { status: "claimed" };
}

/**
 * Redeems a code for the signed-in Account. Every refusal — no code printed, a wrong, malformed,
 * expired or spent code, an owner already present, an inactive or unknown Account — reads the same,
 * so an attempt learns nothing beyond the already-projected `setup_required` state. A refusal after
 * the code matched (the Account cannot own the Home) rolls back, leaving the code usable.
 */
export async function redeemHomeClaimCode(
    input: Readonly<{ accountId: string; code: string; now?: number }>,
): Promise<HomeClaimCodeRedeemResult> {
    const now = input.now ?? Date.now();
    try {
        return await inTx(
            async (tx) => await redeemInTx(tx, { accountId: input.accountId, code: input.code, now }),
            { isolationLevel: "Serializable" },
        );
    } catch (error) {
        if (error instanceof ClaimRefusedAfterSpend) return { status: "refused" };
        throw error;
    }
}
