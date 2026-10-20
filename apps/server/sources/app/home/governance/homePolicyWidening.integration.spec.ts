import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { HomeAuthenticationOptionsV1, HomeGovernancePolicySetInputV1 } from "@happier-dev/protocol";

import { resolveEffectiveHomeAuthMethodsInTx } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { readHomeConfigEnv, readStoredHomeSettingsForStartup } from "@/app/home/settings/homeSettings";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { setHomeGovernancePolicy, setHomeGovernancePolicyInTx } from "./governancePolicy";
import { readHomeGovernanceProjectionInTx } from "./homeGovernanceService";

/**
 * Plan `2026-09-26-home-owner-console` §3.4 / U4: the Home policy decides in both directions where
 * the deployment left a key unset, an explicit deployment key is a lock, widening needs the owner's
 * confirmation, and the audit row commits with the change.
 */
let harness: LightSqliteHarness;
let sequence = 0;

const MTLS_ENABLED_KEY = "HAPPIER_FEATURE_AUTH_MTLS__ENABLED";
const STORAGE_POLICY_KEY = "HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY";

/** A deployment where mTLS could run (trusted proxy headers, keyless Accounts) but is not turned on. */
const MTLS_CAPABLE_ENV: NodeJS.ProcessEnv = {
    HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
    HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
    HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
    [STORAGE_POLICY_KEY]: "optional",
};

async function createOwner(): Promise<string> {
    sequence += 1;
    const created = await db.account.create({
        data: { publicKey: `home-policy-widening-${sequence}`, homeRole: "owner", status: "active" },
        select: { id: true },
    });
    return created.id;
}

async function actionEnabled(env: NodeJS.ProcessEnv, methodId: string, actionId: "login" | "provision"): Promise<boolean> {
    const result = await inTx(async (tx) => await resolveEffectiveHomeAuthMethodsInTx(tx, { env }));
    if (result.status !== "ready") throw new Error("decision unavailable");
    return result.decisions.find((decision) => decision.id === methodId)
        ?.actions.some((action) => action.id === actionId && action.enabled) === true;
}

async function authenticationOptions(owner: string, env: NodeJS.ProcessEnv): Promise<HomeAuthenticationOptionsV1> {
    const projection = await inTx(async (tx) => await readHomeGovernanceProjectionInTx(tx, {
        emailDeliveryReady: false,
        viewerAccountId: owner,
        teamsEnabled: false,
        env,
    }));
    if (projection.status !== "ok") throw new Error(`projection rejected: ${projection.code}`);
    return projection.result.authenticationOptions;
}

async function save(owner: string, env: NodeJS.ProcessEnv, patch: HomeGovernancePolicySetInputV1) {
    return await setHomeGovernancePolicy({ actorAccountId: owner, env, patch });
}

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-home-policy-widening-",
        initAuth: false,
        initEncrypt: false,
        initFiles: false,
    });
});
afterAll(async () => await harness.close());
afterEach(async () => {
    await db.homeAdministrationEvent.deleteMany({});
    await db.homeGovernancePolicy.deleteMany({});
    await db.accountChange.deleteMany({});
    await db.account.deleteMany({});
});

describe("Home policy in both directions", () => {
    it("offers a method the deployment leaves off by default once the Home turns it on", async () => {
        const owner = await createOwner();
        expect(await actionEnabled(MTLS_CAPABLE_ENV, "mtls", "login")).toBe(false);
        const before = await authenticationOptions(owner, MTLS_CAPABLE_ENV);
        expect(before.methods.find((method) => method.id === "mtls")).toMatchObject({ id: "mtls" });
        expect(before.methods.find((method) => method.id === "mtls")?.fixedBy).toBeUndefined();

        const saved = await save(owner, MTLS_CAPABLE_ENV, {
            expectedRevision: 0,
            confirmWidening: true,
            authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge", "mtls"] },
        });
        expect(saved.status).toBe("applied");
        expect(await actionEnabled(MTLS_CAPABLE_ENV, "mtls", "login")).toBe(true);
    });

    it("never lets the Home override a key the deployment set explicitly", async () => {
        const owner = await createOwner();
        const lockedEnv = { ...MTLS_CAPABLE_ENV, [MTLS_ENABLED_KEY]: "0", AUTH_ANONYMOUS_SIGNUP_ENABLED: "0" };

        await save(owner, lockedEnv, {
            expectedRevision: 0,
            confirmWidening: true,
            authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge", "mtls"], anonymousSignup: true },
        });

        expect(await actionEnabled(lockedEnv, "mtls", "login")).toBe(false);
        expect(await actionEnabled(lockedEnv, "key_challenge", "provision")).toBe(false);
        const options = await authenticationOptions(owner, lockedEnv);
        expect(options.methods.find((method) => method.id === "mtls")?.fixedBy).toBe(MTLS_ENABLED_KEY);
        expect(options.anonymousSignup).toEqual({ enabled: false, fixedBy: "AUTH_ANONYMOUS_SIGNUP_ENABLED" });
    });

    it("refuses a widening save without the owner's confirmation and writes nothing", async () => {
        const owner = await createOwner();
        await expect(save(owner, MTLS_CAPABLE_ENV, {
            expectedRevision: 0,
            authenticationPolicy: { v: 1, admission: "invitation_only" },
        })).resolves.toMatchObject({ status: "applied", policy: { revision: 1 } });

        for (const authenticationPolicy of [
            { v: 1 as const, admission: "self_service" as const },
            { v: 1 as const, admission: "invitation_only" as const, enabledMethodIds: ["key_challenge", "mtls"] },
            null,
        ]) {
            await expect(save(owner, MTLS_CAPABLE_ENV, { expectedRevision: 1, authenticationPolicy }))
                .resolves.toEqual({ status: "widening_unconfirmed" });
        }
        await expect(db.homeGovernancePolicy.findUniqueOrThrow({ where: { id: "home" }, select: { revision: true } }))
            .resolves.toEqual({ revision: 1 });
        await expect(db.homeAdministrationEvent.count()).resolves.toBe(1);

        await expect(save(owner, MTLS_CAPABLE_ENV, {
            expectedRevision: 1,
            confirmWidening: true,
            authenticationPolicy: { v: 1, admission: "self_service" },
        })).resolves.toMatchObject({ status: "applied", policy: { revision: 2 } });
        const latest = await db.homeAdministrationEvent.findFirstOrThrow({ orderBy: { at: "desc" } });
        expect(latest).toMatchObject({ action: "home.policy.set", actorAccountId: owner, summary: { revision: 2, widening: true } });
    });

    it("saves a narrowing without a confirmation", async () => {
        const owner = await createOwner();
        await expect(save(owner, MTLS_CAPABLE_ENV, {
            expectedRevision: 0,
            authenticationPolicy: { v: 1, admission: "closed", anonymousSignup: false },
        })).resolves.toMatchObject({ status: "applied" });
        expect(await actionEnabled(MTLS_CAPABLE_ENV, "key_challenge", "provision")).toBe(false);
    });

    it("writes the audit row in the policy transaction", async () => {
        const owner = await createOwner();
        await expect(inTx(async (tx) => {
            const applied = await setHomeGovernancePolicyInTx(tx, {
                emailDeliveryReady: false,
                actorAccountId: owner,
                env: MTLS_CAPABLE_ENV,
                patch: { expectedRevision: 0, confirmWidening: true, authenticationPolicy: { v: 1, admission: "closed" } },
            });
            expect(applied.status).toBe("applied");
            await expect(tx.homeAdministrationEvent.count()).resolves.toBe(1);
            throw new Error("abort after the policy write");
        })).rejects.toThrow("abort after the policy write");

        await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
        await expect(db.homeAdministrationEvent.count()).resolves.toBe(0);
    });

    it("stores the storage policy for the next start without applying it to the running server", async () => {
        const owner = await createOwner();
        const env = { ...MTLS_CAPABLE_ENV };
        delete env[STORAGE_POLICY_KEY];

        await expect(save(owner, env, {
            expectedRevision: 0,
            authenticationPolicy: { v: 1, storagePolicy: "optional" },
        })).resolves.toEqual({ status: "widening_unconfirmed" });
        await expect(save(owner, env, {
            expectedRevision: 0,
            confirmWidening: true,
            authenticationPolicy: { v: 1, storagePolicy: "optional" },
        })).resolves.toMatchObject({ status: "applied" });

        const requestEnv = await readHomeConfigEnv(env);
        expect(requestEnv[STORAGE_POLICY_KEY]).toBeUndefined();
        const stored = await readStoredHomeSettingsForStartup();
        expect(stored.values[STORAGE_POLICY_KEY]).toBe("optional");
        const options = await authenticationOptions(owner, env);
        expect(options.storagePolicy).toEqual({ running: "required_e2ee", pending: "optional", fixedBy: null });

        // The editor replaces the whole document, so the stored value must come back as stored.
        const projection = await inTx(async (tx) => await readHomeGovernanceProjectionInTx(tx, { emailDeliveryReady: false, viewerAccountId: owner, teamsEnabled: false, env }));
        if (projection.status !== "ok") throw new Error("projection rejected");
        expect(projection.result.policy.authentication).toMatchObject({ status: "narrowed", storagePolicy: "optional", anonymousSignup: null });

        const locked = await authenticationOptions(owner, { ...env, [STORAGE_POLICY_KEY]: "required_e2ee" });
        expect(locked.storagePolicy).toEqual({ running: "required_e2ee", pending: null, fixedBy: STORAGE_POLICY_KEY });
    });
});
