import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import {
    createHomeCredentialDestinationDigestV1,
    decodeBase64,
    openBoxBundle,
    type HomeConnectionDescriptorV1,
} from "@happier-dev/protocol";

const { createToken, linkFindUnique, linkFindFirst } = vi.hoisted(() => ({
    createToken: vi.fn(),
    linkFindUnique: vi.fn(),
    linkFindFirst: vi.fn(),
}));
vi.mock("@/storage/db", () => {
    const transaction = {
        $queryRaw: vi.fn(async () => [{ statement_timeout: "0" }]),
        $executeRaw: vi.fn(async () => 0),
        $executeRawUnsafe: vi.fn(async () => 0),
        repeatKey: { findUnique: vi.fn(async () => null) },
        account: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(async () => ({ status: "active" })), update: vi.fn(), updateMany: vi.fn() },
        accountDirectoryLink: { findUnique: linkFindUnique, findFirst: linkFindFirst },
        accountHomeDirectoryEntry: { findUnique: vi.fn() },
    };
    return { db: { ...transaction, $transaction: async (fn: (tx: typeof transaction) => Promise<unknown>) => fn(transaction) } };
});
vi.mock("@/app/auth/auth", () => ({ auth: { init: vi.fn(), createToken } }));
vi.mock("@/app/serverIdentity/serverIdentity", () => ({
    getOrCreateServerIdentityId: vi.fn(async () => "srv_home"),
    readCachedServerIdentityIdForHotPath: vi.fn(() => "srv_home"),
}));

import { db } from "@/storage/db";
import { canonicalHomeLoginAssertionBytes } from "./accountDirectorySigner";
import { redeemHomeLoginAssertion } from "./accountDirectoryService";

const HOME_DESCRIPTOR: HomeConnectionDescriptorV1 = {
    v: 1,
    homeServerIdentityId: "srv_home",
    canonicalServerUrl: "https://home.test",
    revision: 1,
    endpoints: [{ kind: "https", url: "https://home.test" }],
};
const resolveHomeConnectionDescriptor = async () => HOME_DESCRIPTOR;

describe("Account Directory Home redemption security", () => {
    beforeEach(() => {
        createToken.mockReset();
        vi.mocked(db.account.findUnique).mockResolvedValue({ id: "account-1", status: "active" } as never);
    });

    it("never issues an Account token from the Account Service redemption path", async () => {
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4));
        const requesterBoxKeyPair = tweetnacl.box.keyPair();
        const assertion = {
            v: 1 as const,
            purpose: "happier.home-login" as const,
            issuerServerIdentityId: "srv_account",
            issuerSubjectId: "account-1",
            audienceHomeServerIdentityId: "srv_home",
            credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(HOME_DESCRIPTOR),
            clientBoxPublicKeyBase64: privacyKit.encodeBase64(new Uint8Array(requesterBoxKeyPair.publicKey)),
            issuedAtMs: 1_700_000_000_000,
            expiresAtMs: 1_700_000_180_000,
            keyId: createHash("sha256").update(keyPair.publicKey).digest("hex"),
        };
        const signed = {
            ...assertion,
            signatureBase64Url: Buffer.from(tweetnacl.sign.detached(
                canonicalHomeLoginAssertionBytes(assertion), keyPair.secretKey,
            )).toString("base64url"),
        };
        vi.mocked(db.accountDirectoryLink.findUnique).mockResolvedValue({
            accountId: "account-1",
            issuerServerIdentityId: "srv_account",
            issuerSubjectId: "account-1",
            issuerSigningKeyId: assertion.keyId,
            issuerSigningPublicKey: Buffer.from(keyPair.publicKey),
            createdAt: new Date(1_700_000_000_000),
        } as never);
        await expect(redeemHomeLoginAssertion({
            assertion: signed,
            nowMs: assertion.issuedAtMs + 1,
            resolveHomeConnectionDescriptor,
        })).rejects.toMatchObject({
            code: "home_redemption_unavailable",
        });
        expect(createToken).not.toHaveBeenCalled();

        const result = await redeemHomeLoginAssertion({
            assertion: signed,
            nowMs: assertion.issuedAtMs + 1,
            resolveHomeConnectionDescriptor,
            homeApprovalGate: { evaluate: async () => ({
                kind: "approval_required" as const,
                request: { approvalId: "approval-1", deviceLabel: null, expiresAtMs: assertion.expiresAtMs },
            }) },
        });
        expect(result).toMatchObject({ outcome: "approval_required", approvalId: "approval-1" });
        expect(result).not.toHaveProperty("sealedHomeTokenBase64Url");
        expect(createToken).not.toHaveBeenCalled();

        const authorized = await redeemHomeLoginAssertion({
            assertion: signed,
            nowMs: assertion.issuedAtMs + 1,
            resolveHomeConnectionDescriptor,
            homeApprovalGate: { evaluate: async () => ({ kind: "allowed" as const }) },
            issueHomeToken: async () => "home-local-token",
        });
        // Locked authorized response is strict and contains no plaintext token.
        expect(Object.keys(authorized).sort()).toEqual([
            "expiresAtMs",
            "homeServerIdentityId",
            "issuedAtMs",
            "sealedHomeTokenBase64Url",
            "v",
        ]);
        expect(authorized).toMatchObject({ v: 1, homeServerIdentityId: "srv_home" });
        expect(authorized).not.toHaveProperty("outcome");
        expect(authorized).toHaveProperty("sealedHomeTokenBase64Url");
        expect(JSON.stringify(authorized)).not.toContain("home-local-token");
        if (!("sealedHomeTokenBase64Url" in authorized)) throw new Error("expected authorized redemption");
        const opened = openBoxBundle({
            bundle: decodeBase64(authorized.sealedHomeTokenBase64Url, "base64url"),
            recipientSecretKeyOrSeed: requesterBoxKeyPair.secretKey,
        });
        if (!opened) throw new Error("expected sealed Home credential payload");
        expect(new TextDecoder().decode(opened)).toBe('{"token":"home-local-token"}');

        const forged = { ...signed, issuerSubjectId: "attacker" };
        await expect(redeemHomeLoginAssertion({
            assertion: forged,
            nowMs: assertion.issuedAtMs + 1,
            resolveHomeConnectionDescriptor,
            homeApprovalGate: { evaluate: async () => ({ kind: "allowed" as const }) },
            issueHomeToken: async () => "bad",
        })).rejects.toMatchObject({ code: "invalid_subject" });
    });
});
