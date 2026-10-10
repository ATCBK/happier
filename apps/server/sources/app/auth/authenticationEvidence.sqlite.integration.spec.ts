import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashPasswordMaterial } from "@/app/auth/password/passwordMaterialVerifier";
import { listProviderDescriptorsInTx } from "@/app/auth/providers/identityProviderCatalog";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { isAuthenticationEvidenceCurrentInTx, resolveCurrentAuthenticationEvidenceForTeamQualificationInTx } from "./authenticationEvidence";

describe("authentication-evidence native method currentness", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "authentication-evidence-currentness-",
            initAuth: false,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "true",
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "true",
                HAPPIER_FEATURE_AUTH_MTLS__ENABLED: "true",
                HAPPIER_FEATURE_AUTH_MTLS__MODE: "forwarded",
                HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "true",
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "true",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            },
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    const isCurrent = async (accountId: string, methodId: string): Promise<boolean> =>
        await inTx((tx) => isAuthenticationEvidenceCurrentInTx(tx, {
            env: process.env,
            accountId,
            evidence: { kind: "home_method", methodId },
        }));

    it("requires the exact Account to retain each native factor while ignoring session epoch changes", async () => {
        const emailAccount = await db.account.create({
            data: { encryptionMode: "plain", publicKey: null },
        });
        await db.accountIdentity.create({
            data: {
                accountId: emailAccount.id,
                provider: "email",
                providerUserId: "current-factor@example.test",
                profile: {},
            },
        });
        await db.accountPasswordCredential.create({
            data: {
                accountId: emailAccount.id,
                credential: {
                    v: 1,
                    kind: "plain_password_hash",
                    hash: await hashPasswordMaterial(new TextEncoder().encode("current password factor")),
                },
            },
        });
        const otherEmailAccount = await db.account.create({
            data: { encryptionMode: "plain", publicKey: null },
        });
        await db.accountIdentity.create({
            data: {
                accountId: otherEmailAccount.id,
                provider: "email",
                providerUserId: "other-factor@example.test",
                profile: {},
            },
        });
        await db.accountPasswordCredential.create({
            data: {
                accountId: otherEmailAccount.id,
                credential: {
                    v: 1,
                    kind: "plain_password_hash",
                    hash: await hashPasswordMaterial(new TextEncoder().encode("other account password factor")),
                },
            },
        });

        expect(await isCurrent(emailAccount.id, "email_password")).toBe(true);
        await db.account.update({
            where: { id: emailAccount.id },
            data: { tokenEpoch: { increment: 1 } },
        });
        await db.accountPasswordCredential.update({
            where: { accountId: emailAccount.id },
            data: { revision: { increment: 1 } },
        });
        expect(await isCurrent(emailAccount.id, "email_password")).toBe(true);
        await db.accountPasswordCredential.delete({ where: { accountId: emailAccount.id } });
        expect(await isCurrent(emailAccount.id, "email_password")).toBe(false);
        expect(await isCurrent(otherEmailAccount.id, "email_password")).toBe(true);

        const keyAccount = await db.account.create({
            data: { encryptionMode: "e2ee", publicKey: "current-key-challenge-factor" },
        });
        expect(await isCurrent(keyAccount.id, "key_challenge")).toBe(true);
        await db.account.update({
            where: { id: keyAccount.id },
            data: { encryptionMode: "plain" },
        });
        expect(await isCurrent(keyAccount.id, "key_challenge")).toBe(false);
        await db.account.update({
            where: { id: keyAccount.id },
            data: { encryptionMode: "e2ee", publicKey: null },
        });
        expect(await isCurrent(keyAccount.id, "key_challenge")).toBe(false);

        const mtlsAccount = await db.account.create({
            data: { encryptionMode: "plain", publicKey: null },
        });
        await db.accountIdentity.create({
            data: {
                accountId: mtlsAccount.id,
                provider: "mtls",
                providerUserId: "current-mtls-factor",
                profile: {},
            },
        });
        expect(await isCurrent(mtlsAccount.id, "mtls")).toBe(true);
        await db.accountIdentity.delete({
            where: { accountId_provider: { accountId: mtlsAccount.id, provider: "mtls" } },
        });
        expect(await isCurrent(mtlsAccount.id, "mtls")).toBe(false);
    });

    async function createTeamConnectionEvidence(presentationStatus: string, scope: "team" | "home" = "team") {
        const team = await db.team.create({
            data: { name: `WorkOS Evidence Team ${presentationStatus}` },
        });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: scope === "team" ? team.id : null,
                kind: "workos_sso",
                displayName: "Evidence WorkOS",
                enabled: true,
                firstEnabledAt: new Date(),
                config: { v: 1, kind: "workos_sso" },
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: scope === "team" ? team.id : null,
                providerInstanceId: provider.id,
                enabled: true,
                firstEnabledAt: new Date(),
                externalReference: {
                    v: 1,
                    kind: "workos_sso",
                    organizationId: `org_${team.id}`,
                    connectionId: `conn_${team.id}`,
                },
                settings: { v: 1, kind: "workos_sso" },
                lastObservation: {
                    v: 1,
                    kind: "workos_sso",
                    presentation: {
                        displayName: "Acme Okta",
                        strategy: "okta",
                        status: presentationStatus,
                        lastCheckedAt: "2026-09-22T00:00:00.000Z",
                    },
                    successfulTest: null,
                },
            },
        });
        const account = await db.account.create({
            data: { encryptionMode: "plain", publicKey: null },
        });
        const identity = await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: provider.id,
                providerUserId: `member-${presentationStatus}@example.test`,
                profile: {},
            },
        });
        const descriptors = await inTx((tx) => listProviderDescriptorsInTx(tx, process.env,
            scope === "team" ? { kind: "team", teamId: team.id } : { kind: "home" }));
        const descriptor = descriptors.find(({ reference }) => reference.id === provider.id);
        return {
            accountId: account.id,
            evidence: {
                kind: "provider" as const,
                providerId: provider.id,
                identityId: identity.id,
                runtimeFingerprint: descriptor?.reference.runtimeFingerprint ?? "no-descriptor",
                teamConnectionId: connection.id,
            },
        };
    }

    it("reads Team-connection evidence usability through the lifecycle owner's state", async () => {
        harness.resetEnv({
            HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
            WORKOS_API_KEY: "sk_test",
            WORKOS_CLIENT_ID: "client_test",
        });
        await db.homeGovernancePolicy.upsert({
            where: { id: "home" },
            create: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["oidc", "workos_sso"],
                    teamJitAllowed: true,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
            update: {},
        });

        const isEvidenceCurrent = async (target: Awaited<ReturnType<typeof createTeamConnectionEvidence>>) =>
            await inTx((tx) => isAuthenticationEvidenceCurrentInTx(tx, {
                env: process.env,
                accountId: target.accountId,
                evidence: target.evidence,
            }));

        // A live Team connection derives `connected` and keeps its evidence current.
        const live = await createTeamConnectionEvidence("active");
        expect(await isEvidenceCurrent(live)).toBe(true);
        expect(await inTx((tx) => resolveCurrentAuthenticationEvidenceForTeamQualificationInTx(tx, {
            env: process.env,
            accountId: live.accountId,
            evidence: [live.evidence],
        }))).toEqual([live.evidence]);

        // The same connection whose upstream presentation is no longer active
        // derives `needs_attention`. Qualification, policy resolution, admission
        // finalization and the Home method gate all refuse it, so the credential
        // evidence reader must not keep answering from the raw `enabled` column:
        // both rows carry byte-identical `enabled` values, so this case fails on
        // any implementation that re-derives usability from them.
        const stale = await createTeamConnectionEvidence("inactive");
        expect(await isEvidenceCurrent(stale)).toBe(false);

        const home = await createTeamConnectionEvidence("active", "home");
        expect(home.evidence.runtimeFingerprint).not.toBe("no-descriptor");
        expect({
            single: await isEvidenceCurrent(home),
            batch: await inTx((tx) => resolveCurrentAuthenticationEvidenceForTeamQualificationInTx(tx, {
                env: process.env,
                accountId: home.accountId,
                evidence: [home.evidence],
            })),
        }).toEqual({ single: false, batch: [] });

        harness.restoreEnv();
    });
});
