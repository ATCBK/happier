import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readHomeGovernanceProjectionInTx } from "@/app/home/governance/homeGovernanceService";
import { readHomeConfigEnv, setHomeSettings } from "@/app/home/settings/homeSettings";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createHomeMailLinkTargetResolver } from "./homeAuthEmailDelivery";
import { readAuthEmailReadinessFacts, registerAuthEmailApplicationLinkTarget } from "./resolveAuthEmailDelivery";

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
    await db.homeSettings.deleteMany({});
    await db.account.deleteMany({});
});

describe("Home mail link target", () => {
    it("opens mail links at the web-app address the owner stored for this Home", async () => {
        const owner = await createOwner();
        expect(await setHomeSettings({ actorAccountId: owner, write: { expectedRevision: 0, values: { HAPPIER_WEBAPP_URL: OWNER_WEBAPP } } })).toMatchObject({ status: "applied" });

        const resolve = createHomeMailLinkTargetResolver({ continuityStore, readDescriptor });
        await expect(resolve()).resolves.toMatchObject({ applicationOrigin: OWNER_WEBAPP, serverId: "home-identity-1" });

        registerAuthEmailApplicationLinkTarget(resolve);
        await expect(readAuthEmailReadinessFacts({ HAPPIER_WEBAPP_URL: OWNER_WEBAPP })).resolves.toMatchObject({ linkOrigin: OWNER_WEBAPP });
    });

    it("evaluates mail readiness inside a Home-governance transaction without waiting on its own connection", async () => {
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

        // As a route does: the request's Home overlay (which carries the stored SMTP host) is read
        // before the transaction. Governance then reads mail readiness inside its transaction;
        // SQLite runs one connection, so a link-target read that went around the transaction would
        // stall until P2028.
        const env = await readHomeConfigEnv();
        const projection = await inTx(async (tx) => await readHomeGovernanceProjectionInTx(tx, {
            viewerAccountId: owner,
            teamsEnabled: true,
            env,
        }));
        expect(projection.status).toBe("ok");
    }, 60_000);
});
