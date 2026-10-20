import { createHash } from "node:crypto";
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";

import {
    consumeAccountEncryptionFirstKeyExternalAuthProofInTx,
    consumeAccountPasswordEnrollmentExternalAuthProofInTx,
} from "@/app/auth/accountEncryptionFirstKeyExternalAuthProof";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { acquireMtlsAuthenticationClaimInTx, beginMtlsTeamHandoff, createMtlsClaimCode, createMtlsTeamHandoff } from "./mtlsClaimCode";

function sha256Hex(value: string): string {
    return createHash("sha256")
        .update(value, "utf8")
        .digest("hex");
}

describe("mTLS first-key step-up claim consumption", () => {
    let harness: LightSqliteHarness;

    const currentMtlsPolicy = {
        HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "true",
        HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
        HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "true",
        HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: "example.com",
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: "cn=Example Root CA",
        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "true",
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
    } as const;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-mtls-step-up-claim-",
            initAuth: false,
            env: currentMtlsPolicy,
        });
    });

    afterEach(async () => {
        Object.assign(process.env, currentMtlsPolicy);
        await harness.resetDbTables([
            () => db.homeGovernancePolicy.deleteMany(),
            () => db.accountIdentity.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    afterAll(async () => {
        await harness.close();
    });

    it("starts a prepared Team handoff in the browser exactly once", async () => {
        const returnTo = "https://app.example.com/join";
        const admissionReference = await createMtlsTeamHandoff({ returnTo, teamId: "team-1", ttlMs: 60_000 });

        await expect(beginMtlsTeamHandoff({ admissionReference, returnTo: "https://other.example.com" })).resolves.toBe(false);
        await expect(beginMtlsTeamHandoff({ admissionReference, returnTo })).resolves.toBe(true);
        await expect(beginMtlsTeamHandoff({ admissionReference, returnTo })).resolves.toBe(false);
    });

    async function createFixture() {
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "mtls",
                providerUserId: "alice@example.com",
                profile: {},
            },
        });
        const proof = "fresh-mtls-browser-proof";
        const requestDigest = `aemrb1_${"A".repeat(43)}`;
        const pending = await createMtlsClaimCode({
            userId: account.id,
            ttlMs: 60_000,
            stepUp: {
                purpose:
                    "account_encryption_first_key",
                providerUserId: "alice@example.com",
                proofHash: sha256Hex(proof),
                requestDigest,
            },
        });
        return {
            accountId: account.id,
            requestDigest,
            externalAuthProof: {
                provider: "mtls",
                pending,
                proof,
            },
        } as const;
    }

    async function createPasswordEnrollmentFixture() {
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "mtls",
                providerUserId: "alice@example.com",
                profile: {},
            },
        });
        const proof = "fresh-mtls-browser-proof";
        const requestDigest = "A".repeat(43);
        const pending = await createMtlsClaimCode({
            userId: account.id,
            ttlMs: 60_000,
            stepUp: {
                purpose: "account_password_enrollment",
                providerUserId: "alice@example.com",
                proofHash: sha256Hex(proof),
                requestDigest,
            },
        });
        return {
            accountId: account.id,
            requestDigest,
            externalAuthProof: {
                provider: "mtls",
                pending,
                proof,
            },
        } as const;
    }

    async function consumePasswordEnrollmentFixture(
        fixture: Awaited<ReturnType<typeof createPasswordEnrollmentFixture>>,
    ) {
        return await inTx(async (tx) =>
            await consumeAccountPasswordEnrollmentExternalAuthProofInTx(
                tx,
                fixture,
            ));
    }

    it("consumes a password-enrollment claim while its mTLS security policy is unchanged", async () => {
        const fixture = await createPasswordEnrollmentFixture();

        await expect(consumePasswordEnrollmentFixture(fixture)).resolves.toEqual({
            ok: true,
            provider: "mtls",
            providerUserId: "alice@example.com",
        });
    });

    it("rejects a length-valid non-canonical password mutation digest", async () => {
        const fixture = await createPasswordEnrollmentFixture();
        const key = `mtls_claim_${fixture.externalAuthProof.pending}`;
        const row = await db.repeatKey.findUniqueOrThrow({ where: { key } });
        await db.repeatKey.update({
            where: { key },
            data: {
                value: JSON.stringify({
                    ...JSON.parse(row.value),
                    requestDigest: "!".repeat(43),
                }),
            },
        });

        await expect(consumePasswordEnrollmentFixture({
            ...fixture,
            requestDigest: "!".repeat(43),
        })).resolves.toEqual({
            ok: false,
            reason: "invalid_or_consumed",
        });
    });

    it.each([
        ["mTLS is disabled", "HAPPIER_FEATURE_AUTH_MTLS__ENABLED", "false"],
        ["forwarded-header trust is revoked", "HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS", "false"],
        ["the issuer allowlist changes", "HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS", "cn=Replacement Root CA"],
        ["the email-domain allowlist changes", "HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS", "replacement.example"],
    ] as const)(
        "rejects and retires a password-enrollment claim when %s",
        async (_label, envKey, nextValue) => {
            const fixture = await createPasswordEnrollmentFixture();
            process.env[envKey] = nextValue;

            await expect(consumePasswordEnrollmentFixture(fixture)).resolves.toEqual({
                ok: false,
                reason: "configuration_changed",
            });
            expect(await db.repeatKey.findUnique({
                where: { key: `mtls_claim_${fixture.externalAuthProof.pending}` },
            })).toBeNull();
        },
    );

    it("rejects and retires a claim when current Home policy disables mTLS", async () => {
        const fixture = await createPasswordEnrollmentFixture();
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                authenticationPolicy: {
                    v: 1,
                    enabledMethodIds: ["key_challenge"],
                },
            },
        });

        await expect(consumePasswordEnrollmentFixture(fixture)).resolves.toEqual({
            ok: false,
            reason: "configuration_changed",
        });
        expect(await db.repeatKey.findUnique({
            where: { key: `mtls_claim_${fixture.externalAuthProof.pending}` },
        })).toBeNull();
    });

    it("applies the same mTLS policy currentness fence to first-key claims", async () => {
        const fixture = await createFixture();
        process.env.HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS = "replacement.example";

        await expect(inTx(async (tx) =>
            await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
                tx,
                fixture,
            ))).resolves.toEqual({
            ok: false,
            reason: "configuration_changed",
        });
    });

    it("retires the unreleased step-up shape that has no issuance security binding", async () => {
        const fixture = await createPasswordEnrollmentFixture();
        const key = `mtls_claim_${fixture.externalAuthProof.pending}`;
        const row = await db.repeatKey.findUniqueOrThrow({ where: { key } });
        const { securityBinding: _securityBinding, ...unbound } = JSON.parse(row.value);
        await db.repeatKey.update({
            where: { key },
            data: { value: JSON.stringify(unbound) },
        });

        await expect(consumePasswordEnrollmentFixture(fixture)).resolves.toEqual({
            ok: false,
            reason: "configuration_changed",
        });
        expect(await db.repeatKey.findUnique({ where: { key } })).toBeNull();
    });

    it("never redeems a password-enrollment claim as ordinary login", async () => {
        const fixture = await createPasswordEnrollmentFixture();

        await expect(inTx(async (tx) => await acquireMtlsAuthenticationClaimInTx(tx, {
            code: fixture.externalAuthProof.pending,
        }))).resolves.toBeNull();
    });

    it.each([
        [
            "wrong request",
            (fixture: Awaited<
                ReturnType<typeof createFixture>
            >) => ({
                ...fixture,
                requestDigest:
                    `aemrb1_${"B".repeat(43)}`,
            }),
            "binding_mismatch",
        ],
        [
            "wrong proof",
            (fixture: Awaited<
                ReturnType<typeof createFixture>
            >) => ({
                ...fixture,
                externalAuthProof: {
                    ...fixture.externalAuthProof,
                    proof: "wrong-proof",
                },
            }),
            "binding_mismatch",
        ],
        [
            "wrong provider",
            (fixture: Awaited<
                ReturnType<typeof createFixture>
            >) => ({
                ...fixture,
                externalAuthProof: {
                    ...fixture.externalAuthProof,
                    provider: "github",
                },
            }),
            "invalid_or_consumed",
        ],
    ])(
        "fails closed for %s and leaves the claim retryable",
        async (_label, mutate, reason) => {
            const fixture = await createFixture();
            await expect(inTx(async (tx) =>
                await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
                    tx,
                    mutate(fixture),
                ))).resolves.toEqual({
                ok: false,
                reason,
            });
            expect(await db.repeatKey.findUnique({
                where: {
                    key:
                        `mtls_claim_${
                            fixture.externalAuthProof.pending
                        }`,
                },
            })).not.toBeNull();
        },
    );

    it("fails closed for expiry and stale identity without consuming the claim", async () => {
        const expired = await createFixture();
        await db.repeatKey.update({
            where: {
                key:
                    `mtls_claim_${
                        expired.externalAuthProof.pending
                    }`,
            },
            data: { expiresAt: new Date(Date.now() - 1) },
        });
        await expect(inTx(async (tx) =>
            await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
                tx,
                expired,
            ))).resolves.toEqual({
            ok: false,
            reason: "expired",
        });

        await harness.resetDbTables([
            () => db.accountIdentity.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
        const staleIdentity = await createFixture();
        await db.accountIdentity.deleteMany({
            where: {
                accountId: staleIdentity.accountId,
            },
        });
        await expect(inTx(async (tx) =>
            await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
                tx,
                staleIdentity,
            ))).resolves.toEqual({
            ok: false,
            reason: "identity_mismatch",
        });
        expect(await db.repeatKey.findUnique({
            where: {
                key:
                    `mtls_claim_${
                        staleIdentity.externalAuthProof.pending
                    }`,
            },
        })).not.toBeNull();
    });

    it("rolls consumption back with the Account transaction and remains single-use after commit", async () => {
        const fixture = await createFixture();

        await expect(inTx(async (tx) => {
            const consumed =
                await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
                    tx,
                    fixture,
                );
            expect(consumed.ok).toBe(true);
            throw new Error("later-migration-write-rejected");
        })).rejects.toThrow(
            "later-migration-write-rejected",
        );

        await expect(inTx(async (tx) =>
            await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
                tx,
                fixture,
            ))).resolves.toEqual({
            ok: true,
            provider: "mtls",
            providerUserId: "alice@example.com",
        });
        await expect(inTx(async (tx) =>
            await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
                tx,
                fixture,
            ))).resolves.toEqual({
            ok: false,
            reason: "invalid_or_consumed",
        });
    });
});
