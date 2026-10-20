import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import {
    createPasswordMutationChallengeSigningInputV1,
    encodePasswordCredentialFieldV1,
    type PasswordCredentialMutationV1,
} from "@happier-dev/protocol";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import {
    issueKeyChallengeV2,
    issuePasswordMutationKeyChallengeV1,
    consumePasswordMutationKeyChallengeInTx,
} from "./keyChallengeV2";

describe("Key Challenge password mutation (real database)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-password-challenge-",
            env: { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test", HAPPIER_SERVER_IDENTITY_ID: "srv_password_home" },
        });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    async function prepare(encryptionMode: "plain" | "e2ee" = "e2ee") {
        const signing = tweetnacl.sign.keyPair();
        const account = await db.account.create({ data: {
            publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)), encryptionMode,
        } });
        const mutation: PasswordCredentialMutationV1 = {
            v: 1, action: "change", accountId: account.id, expectedCredentialRevision: 1,
            normalizedNativeEmail: "alice@example.test", newCredentialDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        };
        const challenge = await issuePasswordMutationKeyChallengeV1({ mutation, env: process.env });
        if (!challenge) throw new Error("challenge issuance unavailable");
        const proof = {
            challengeId: challenge.challengeId,
            publicKey: encodePasswordCredentialFieldV1(new Uint8Array(signing.publicKey)),
            signature: encodePasswordCredentialFieldV1(new Uint8Array(tweetnacl.sign.detached(
                createPasswordMutationChallengeSigningInputV1(challenge), signing.secretKey,
            ))),
        };
        const consume = (candidate = mutation) => inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "exclusive");
            return consumePasswordMutationKeyChallengeInTx(tx, { mutation: candidate, proof, env: process.env });
        });
        return { account, mutation, challenge, proof, consume };
    }

    it("rejects a valid signing proof for a currently Plain Account without consuming it", async () => {
        const prepared = await prepare("plain");
        expect(await prepared.consume()).toBe(false);
        expect(await db.keyChallengeV2.findUnique({ where: { id: prepared.challenge.challengeId } }))
            .toMatchObject({ consumedAt: null });
    });

    it("rejects a disabled Account without consuming a valid mutation proof", async () => {
        const prepared = await prepare();
        await inTx((tx) => setAccountStatusInTx(tx, { actorAccountId: prepared.account.id, targetAccountId: prepared.account.id, status: "disabled", authority: "account_erasure" }));
        expect(await prepared.consume()).toBe(false);
        expect(await db.keyChallengeV2.findUnique({ where: { id: prepared.challenge.challengeId } }))
            .toMatchObject({ consumedAt: null });
    });

    it("binds mutation revision and kind, and claims a matching proof only once", async () => {
        const prepared = await prepare();
        expect(await prepared.consume({ ...prepared.mutation, expectedCredentialRevision: 2 })).toBe(false);
        await db.keyChallengeV2.update({ where: { id: prepared.challenge.challengeId }, data: { operationKind: "unknown" } });
        expect(await prepared.consume()).toBe(false);
        await db.keyChallengeV2.update({ where: { id: prepared.challenge.challengeId }, data: { operationKind: "password_credential_mutation_v1" } });
        expect(await prepared.consume()).toBe(true);
        expect(await prepared.consume()).toBe(false);
    });

    it("claims exactly one of two simultaneous valid proofs over the same credential revision", async () => {
        const prepared = await prepare();
        // Two concurrent transactions present the same valid proof for the same
        // revision. The claim is once-only, so exactly one commits the mutation
        // and the loser is refused rather than silently applying twice.
        const outcomes = await Promise.allSettled([prepared.consume(), prepared.consume()]);
        const claims = outcomes.map((outcome) => outcome.status === "fulfilled" ? outcome.value : "rejected");
        expect(claims.filter((claim) => claim === true)).toHaveLength(1);
        expect(claims.filter((claim) => claim === true || claim === false || claim === "rejected")).toHaveLength(2);
        expect(await db.keyChallengeV2.findUnique({ where: { id: prepared.challenge.challengeId } }))
            .toMatchObject({ consumedAt: expect.any(Date) });
        expect(await prepared.consume()).toBe(false);
    });

    it("reads persisted Home identity within the caller transaction and rejects a changed Home", async () => {
        const prepared = await prepare();
        const wrongHome = { ...process.env, HAPPIER_SERVER_IDENTITY_ID: "srv_different_home" };
        expect(await inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, prepared.account.id, "exclusive");
            return consumePasswordMutationKeyChallengeInTx(tx, {
                mutation: prepared.mutation, proof: prepared.proof, env: wrongHome,
            });
        })).toBe(false);
        const persistedHome = { ...process.env, HAPPIER_SERVER_IDENTITY_ID: undefined };
        expect(await inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, prepared.account.id, "exclusive");
            return consumePasswordMutationKeyChallengeInTx(tx, {
                mutation: prepared.mutation, proof: prepared.proof, env: persistedHome,
            });
        })).toBe(true);
    });

    it("rejects a substituted Account signing key without consuming the challenge", async () => {
        const prepared = await prepare();
        const other = tweetnacl.sign.keyPair();
        const proof = {
            challengeId: prepared.challenge.challengeId,
            publicKey: encodePasswordCredentialFieldV1(new Uint8Array(other.publicKey)),
            signature: encodePasswordCredentialFieldV1(new Uint8Array(tweetnacl.sign.detached(
                createPasswordMutationChallengeSigningInputV1(prepared.challenge), other.secretKey,
            ))),
        };
        expect(await inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, prepared.account.id, "exclusive");
            return consumePasswordMutationKeyChallengeInTx(tx, { mutation: prepared.mutation, proof, env: process.env });
        })).toBe(false);
        expect(await prepared.consume()).toBe(true);
    });

    it("rolls challenge consumption back with a failing enclosing mutation", async () => {
        const prepared = await prepare();
        await expect(inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, prepared.account.id, "exclusive");
            expect(await consumePasswordMutationKeyChallengeInTx(tx, {
                mutation: prepared.mutation, proof: prepared.proof, env: process.env,
            })).toBe(true);
            throw new Error("credential mutation failed");
        })).rejects.toThrow("credential mutation failed");
        expect(await db.keyChallengeV2.findUnique({ where: { id: prepared.challenge.challengeId } }))
            .toMatchObject({ consumedAt: null });
        expect(await prepared.consume()).toBe(true);
    });

    it("rejects login challenges and expired mutation challenges", async () => {
        const prepared = await prepare();
        const login = await issueKeyChallengeV2({ purpose: "account", expectedAccountId: prepared.account.id, env: process.env });
        expect(login).not.toBeNull();
        expect(await inTx((tx) => consumePasswordMutationKeyChallengeInTx(tx, {
            mutation: prepared.mutation, proof: { ...prepared.proof, challengeId: login!.challengeId }, env: process.env,
        }))).toBe(false);
        await db.keyChallengeV2.update({ where: { id: prepared.challenge.challengeId }, data: { expiresAt: new Date(0) } });
        expect(await prepared.consume()).toBe(false);
    });
});
