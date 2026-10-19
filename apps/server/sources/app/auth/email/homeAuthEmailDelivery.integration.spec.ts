import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readHomeGovernanceProjectionInTx } from "@/app/home/governance/homeGovernanceService";
import { readHomeConfigEnv, setHomeSettings } from "@/app/home/settings/homeSettings";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { homeGovernanceRoutes } from "@/app/api/routes/home/homeGovernanceRoutes";
import { resolveAuthEntry } from "@/app/auth/entry/resolveAuthEntry";
import { issueNativeAuthOneTimeOperationInTx } from "./nativeAuthOneTimeOperations";

import { createHomeMailLinkTargetResolver } from "./homeAuthEmailDelivery";
import { isAuthEmailDeliveryReady, readAuthEmailReadinessFacts, registerAuthEmailApplicationLinkTarget } from "./resolveAuthEmailDelivery";

let harness: LightSqliteHarness;
let sequence = 0;

const OWNER_WEBAPP = "https://owner-set.example.test";

/** Descriptor publication is its own owner; here it answers with a fixed published descriptor. */
const continuityStore = {
    read: async () => null,
    write: async () => ({ status: "unchanged" as const, continuity: { revision: 1, contentKey: "v1:n:" + "a".repeat(64) } }),
};
const readDescriptor = async () => ({
    v: 1 as const,
    homeServerIdentityId: "home-identity-1",
    canonicalServerUrl: "https://home.example.test",
    revision: 1,
    endpoints: [{ kind: "https" as const, url: "https://home.example.test" }],
});

async function createOwner(): Promise<string> {
    sequence += 1;
    const created = await db.account.create({
        data: { publicKey: `home-mail-link-${sequence}`, homeRole: "owner", status: "active" },
        select: { id: true },
    });
    return created.id;
}

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-home-mail-link-",
        // The light runtime's SQLite runs one connection; the deadlock this guards against needs it.
        sqliteConnectionLimit: 1,
        initAuth: false,
        initEncrypt: true,
        initFiles: false,
    });
}, 300_000);
afterAll(async () => {
    registerAuthEmailApplicationLinkTarget(null);
    await harness.close();
});
beforeEach(() => {
    // This flow exercises an owner-stored address, not a deployment-locked address.
    harness.resetEnv({ HAPPIER_WEBAPP_URL: undefined, HAPPY_WEBAPP_URL: undefined });
});
afterEach(async () => {
    registerAuthEmailApplicationLinkTarget(null);
    await db.homeAdministrationEvent.deleteMany({});
    await db.homeGovernancePolicy.deleteMany({});
    await db.repeatKey.deleteMany({});
    await db.homeSettings.deleteMany({});
    await db.account.deleteMany({});
});

describe("Home mail link target", () => {
    it.each([
        "governance/get", "accounts/list", "accounts/get", "accounts/role/set",
        "accounts/sign-out-everywhere", "accounts/disable", "accounts/enable", "policy/set",
        "native-email-verification",
    ])("prepares native mail-link readiness before opening the governance snapshot: %s", async journey => {
        const owner = await createOwner();
        const person = await db.account.create({ data: { publicKey: crypto.randomUUID(), homeRole: "member" } });
        await setHomeSettings({ actorAccountId: owner, write: { expectedRevision: 0, values: {
            HAPPIER_WEBAPP_URL: OWNER_WEBAPP,
            HAPPIER_AUTH_EMAIL_SMTP_HOST: "smtp.home.test",
            HAPPIER_AUTH_EMAIL_FROM_ADDRESS: "home@home.test",
        } } });
        const verification = journey === "native-email-verification"
            ? await inTx(tx => issueNativeAuthOneTimeOperationInTx(tx, {
                v: 1, purpose: "verify_native_email", normalizedEmail: "person@example.test",
                consumer: { kind: "fresh_account", continuationId: null },
            }))
            : null;
        let activeTransactions = 0;
        const transactionsDuringNativeObservation: number[] = [];
        const transaction = db.$transaction;
        // Instrument the real database boundary; all governance and mail-readiness logic stays real.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            activeTransactions += 1;
            return Promise.resolve(Reflect.apply(target, receiver, args)).finally(() => { activeTransactions -= 1; });
        } });
        registerAuthEmailApplicationLinkTarget(createHomeMailLinkTargetResolver({ continuityStore,
            readDescriptor: async () => {
                transactionsDuringNativeObservation.push(activeTransactions);
                return await readDescriptor();
            },
        }));
        try {
            if (verification) {
                const projection = await resolveAuthEntry({ v: 1,
                    scope: { kind: "native_email_verification", token: verification.rawBearer },
                }, { env: await readHomeConfigEnv() });
                expect(projection.scope.kind).toBe("home");
                expect(transactionsDuringNativeObservation.length).toBeGreaterThan(0);
                expect(transactionsDuringNativeObservation.every(count => count === 0)).toBe(true);
                return;
            }
            await withAuthenticatedTestApp(homeGovernanceRoutes, async app => {
                const journeys = [
                    { url: "/v1/home/governance/get", payload: {} },
                    { url: "/v1/home/accounts/list", payload: {} },
                    { url: "/v1/home/accounts/get", payload: { accountId: person.id } },
                    { url: "/v1/home/accounts/role/set", payload: { accountId: person.id, homeRole: "admin" } },
                    { url: "/v1/home/accounts/sign-out-everywhere", payload: { accountId: person.id } },
                    { url: "/v1/home/accounts/disable", payload: { accountId: person.id } },
                    { url: "/v1/home/accounts/enable", payload: { accountId: person.id } },
                    { url: "/v1/home/policy/set", payload: { expectedRevision: 0,
                        authenticationPolicy: { v: 1, admission: "invitation_only" } } },
                ];
                for (const request of journeys.filter(request => request.url === `/v1/home/${journey}`)) {
                    transactionsDuringNativeObservation.length = 0;
                    const response = await app.inject({ method: "POST", ...request,
                        headers: { "x-test-user-id": owner } });
                    expect(response.statusCode, response.body).toBe(200);
                    expect(transactionsDuringNativeObservation.length, request.url).toBeGreaterThan(0);
                    expect(transactionsDuringNativeObservation.every(count => count === 0), request.url).toBe(true);
                }
            });
        } finally {
            db.$transaction = transaction;
        }
    });

    it("opens mail links at the web-app address the owner stored for this Home", async () => {
        const owner = await createOwner();
        expect(await setHomeSettings({ actorAccountId: owner, write: { expectedRevision: 0, values: { HAPPIER_WEBAPP_URL: OWNER_WEBAPP } } })).toMatchObject({ status: "applied" });

        const resolve = createHomeMailLinkTargetResolver({ continuityStore, readDescriptor });
        await expect(resolve()).resolves.toMatchObject({ applicationOrigin: OWNER_WEBAPP, serverId: "home-identity-1" });

        registerAuthEmailApplicationLinkTarget(resolve);
        await expect(readAuthEmailReadinessFacts({ HAPPIER_WEBAPP_URL: OWNER_WEBAPP })).resolves.toMatchObject({ linkOrigin: OWNER_WEBAPP });
    });

    it("consumes prepared mail readiness in a Home-governance transaction", async () => {
        const owner = await createOwner();
        await setHomeSettings({
            actorAccountId: owner,
            write: {
                expectedRevision: 0,
                values: {
                    HAPPIER_WEBAPP_URL: OWNER_WEBAPP,
                    HAPPIER_AUTH_EMAIL_SMTP_HOST: "smtp.home.test",
                    HAPPIER_AUTH_EMAIL_FROM_ADDRESS: "home@home.test",
                },
            },
        });
        registerAuthEmailApplicationLinkTarget(createHomeMailLinkTargetResolver({ continuityStore, readDescriptor }));

        // The request's Home overlay and native mail-link readiness are both
        // prepared before the single-connection governance transaction opens.
        const env = await readHomeConfigEnv();
        const emailDeliveryReady = await isAuthEmailDeliveryReady({ env });
        expect(emailDeliveryReady).toBe(true);
        const projection = await inTx(async (tx) => await readHomeGovernanceProjectionInTx(tx, {
            viewerAccountId: owner,
            teamsEnabled: true,
            env,
            emailDeliveryReady,
        }));
        expect(projection.status).toBe("ok");
    }, 60_000);
});
