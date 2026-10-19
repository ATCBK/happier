import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createTeamInTx } from "@/app/teams/lifecycle";
import { admitTeamMemberInTx } from "@/app/teams/memberships/membershipService";

import { HOME_GOVERNANCE_POLICY_ID } from "./governancePolicy";
import { setHomeRoleInTx } from "./homeGovernanceService";
import { bootstrapPersonalHomeTeams } from "./personalHomeTeamsBootstrap";

const PERSONAL_HOME_ENV: NodeJS.ProcessEnv = {
    HAPPIER_MANAGED_RELAY_PURPOSE: "personal-home",
    HAPPIER_FEATURE_TEAMS__ENABLED: "1",
    HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
};

let harness: LightSqliteHarness;

const PERSONAL_HOME_DEFAULT_TEAM_ID = "personal-home-default-team-v1";

/**
 * Simulates the transaction-consistent stale snapshot a concurrent committed
 * creator can leave behind on PostgreSQL/MySQL: every lookup by the first
 * transaction misses the row, then its create reaches the real unique
 * constraint. Only the database delegate is intercepted; the full bootstrap
 * transaction and its canonical domain owners still run unchanged.
 */
function hideFirstBootstrapIdentityLookup(
    delegate: "team" | "homeGovernancePolicy",
) {
    // Test-only boundary fixture: Prisma's generated transaction delegate has
    // no public constructor/type for wrapping one model method.
    const mutableDb = db as any;
    const original = mutableDb.$transaction;
    let hidTransaction = false;
    mutableDb.$transaction = async (...args: unknown[]) => {
        const operation = args[0];
        if (typeof operation !== "function") return await Reflect.apply(original, mutableDb, args);
        const shouldHide = !hidTransaction;
        hidTransaction = true;
        return await Reflect.apply(original, mutableDb, [async (tx: any) => {
            const model = new Proxy(tx[delegate], {
                get(target, property, receiver) {
                    if (property !== "findUnique") return Reflect.get(target, property, receiver);
                    return (...findArgs: unknown[]) => {
                        if (shouldHide) return Promise.resolve(null);
                        return Reflect.apply(target.findUnique, target, findArgs);
                    };
                },
            });
            return await operation(new Proxy(tx, {
                get(target, property, receiver) {
                    return property === delegate ? model : Reflect.get(target, property, receiver);
                },
            }));
        }, ...args.slice(1)]);
    };
    return {
        restore: () => { mutableDb.$transaction = original; },
        didHide: () => hidTransaction,
    } as const;
}

async function createAccount(input?: Readonly<{
    homeRole?: "owner" | "admin" | "member";
    status?: "active" | "suspended" | "disabled";
}>) {
    return await db.account.create({
        data: {
            publicKey: crypto.randomUUID(),
            encryptionMode: "plain",
            homeRole: input?.homeRole ?? "member",
            status: input?.status ?? "active",
        },
    });
}

async function bootstrap(
    overrides?: Readonly<{
        runtimePurpose?: string | null;
        defaultTeamName?: string;
        env?: NodeJS.ProcessEnv;
    }>,
) {
    return await bootstrapPersonalHomeTeams({
        runtimePurpose: overrides?.runtimePurpose ?? "personal-home",
        defaultTeamName: overrides?.defaultTeamName ?? "My Team",
        env: overrides?.env ?? PERSONAL_HOME_ENV,
    });
}

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-personal-home-teams-bootstrap-",
        initAuth: false,
        initEncrypt: false,
        initFiles: false,
    });
}, 180_000);

afterAll(async () => await harness.close());

afterEach(async () => {
    await db.repeatKey.deleteMany({});
    await db.teamMembership.deleteMany({});
    await db.team.deleteMany({});
    await db.homeGovernancePolicy.deleteMany({});
    await db.account.deleteMany({});
});

describe("Personal Home Teams bootstrap", () => {
    it("claims the sole bootstrap Account and atomically establishes the H6 defaults and default Team", async () => {
        const account = await createAccount();

        const result = await bootstrap();

        expect(result).toMatchObject({
            status: "ready",
        });
        if (result.status !== "ready") return;
        await expect(db.account.findUniqueOrThrow({ where: { id: account.id }, select: { homeRole: true } }))
            .resolves.toEqual({ homeRole: "owner" });
        await expect(db.homeGovernancePolicy.findUniqueOrThrow({
            where: { id: HOME_GOVERNANCE_POLICY_ID },
            select: { teamCreationPolicy: true, authenticationPolicy: true },
        })).resolves.toEqual({
            teamCreationPolicy: "managed_only",
            authenticationPolicy: { v: 1, admission: "invitation_only" },
        });
        await expect(db.team.findUniqueOrThrow({
            where: { id: result.teamId },
            select: { name: true, admissionMode: true },
        })).resolves.toEqual({ name: "My Team", admissionMode: "invite_only" });
        await expect(db.teamMembership.findMany({
            where: { teamId: result.teamId },
            select: { accountId: true, role: true, status: true },
        })).resolves.toEqual([{ accountId: account.id, role: "owner", status: "active" }]);
    });

    it("reuses the same initialized Team on retry", async () => {
        await createAccount();

        const first = await bootstrap();
        const firstPolicy = await db.homeGovernancePolicy.findUniqueOrThrow({
            where: { id: HOME_GOVERNANCE_POLICY_ID },
            select: { revision: true },
        });
        // The canonical Team identity, not the ordinary short-lived Action
        // RepeatKey, must make startup retry durable across arbitrary restarts.
        await db.repeatKey.deleteMany({});
        const retry = await bootstrap();

        expect(first.status).toBe("ready");
        expect(retry).toEqual(first);
        await expect(db.team.count()).resolves.toBe(1);
        await expect(db.teamMembership.count()).resolves.toBe(1);
        await expect(db.homeGovernancePolicy.findUniqueOrThrow({
            where: { id: HOME_GOVERNANCE_POLICY_ID },
            select: { revision: true },
        })).resolves.toEqual(firstPolicy);
    });

    it("rejoins a concurrent reserved-Team winner after the create reaches the unique constraint", async () => {
        await createAccount({ homeRole: "owner" });
        const winner = await bootstrap({ defaultTeamName: "Concurrent winner" });
        expect(winner).toEqual({
            status: "ready",
            teamId: PERSONAL_HOME_DEFAULT_TEAM_ID,
        });
        // H6 must converge through the durable Team identity even after its
        // ordinary Action RepeatKey has expired.
        await db.repeatKey.deleteMany({});
        const hidden = hideFirstBootstrapIdentityLookup("team");

        try {
            await expect(bootstrap()).resolves.toEqual({
                status: "ready",
                teamId: PERSONAL_HOME_DEFAULT_TEAM_ID,
            });
        } finally {
            hidden.restore();
        }

        expect(hidden.didHide()).toBe(true);
        await expect(db.team.count({ where: { id: PERSONAL_HOME_DEFAULT_TEAM_ID } })).resolves.toBe(1);
        await expect(db.teamMembership.count({
            where: { teamId: PERSONAL_HOME_DEFAULT_TEAM_ID, role: "owner", status: "active" },
        })).resolves.toBe(1);
    });

    it("restarts after a concurrent first governance-policy writer wins", async () => {
        await createAccount({ homeRole: "owner" });
        await db.homeGovernancePolicy.create({
            data: { id: HOME_GOVERNANCE_POLICY_ID, revision: 1 },
        });
        const hidden = hideFirstBootstrapIdentityLookup("homeGovernancePolicy");

        try {
            const result = await bootstrap();
            expect(result.status).toBe("ready");
        } finally {
            hidden.restore();
        }

        expect(hidden.didHide()).toBe(true);
        await expect(db.team.count({ where: { id: PERSONAL_HOME_DEFAULT_TEAM_ID } })).resolves.toBe(1);
        await expect(db.homeGovernancePolicy.findUniqueOrThrow({
            where: { id: HOME_GOVERNANCE_POLICY_ID },
            select: { revision: true },
        })).resolves.toEqual({ revision: 2 });
    });

    it("rejects any runtime purpose other than Personal Home without mutating state", async () => {
        const account = await createAccount();

        await expect(bootstrap({
            runtimePurpose: "managed-cloud",
            env: {
                ...PERSONAL_HOME_ENV,
                HAPPIER_BUILD_FEATURES_DENY: "teams",
            },
        }))
            .resolves.toEqual({ status: "not_personal_home" });

        await expect(db.account.findUniqueOrThrow({ where: { id: account.id }, select: { homeRole: true } }))
            .resolves.toEqual({ homeRole: "member" });
        await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
        await expect(db.team.count()).resolves.toBe(0);
    });

    it("reports setup required when no active Account can own the absent default Team", async () => {
        await expect(bootstrap()).resolves.toEqual({ status: "setup_required" });

        await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
        await expect(db.team.count()).resolves.toBe(0);
    });

    it("reuses the default Team after a later invited member joins the Home", async () => {
        const bootstrapAccount = await createAccount();
        const initialized = await bootstrap();
        if (initialized.status !== "ready") throw new Error(`Unexpected bootstrap result: ${initialized.status}`);
        const invitedAccount = await createAccount();
        const admitted = await inTx((tx) => admitTeamMemberInTx(tx, {
            teamId: initialized.teamId,
            accountId: invitedAccount.id,
            role: "member",
            historyAccess: "all_existing",
        }));
        expect(admitted.ok).toBe(true);

        await expect(bootstrap()).resolves.toEqual({
            status: "ready",
            teamId: initialized.teamId,
        });

        await expect(db.account.findUniqueOrThrow({
            where: { id: bootstrapAccount.id },
            select: { homeRole: true },
        })).resolves.toEqual({ homeRole: "owner" });
        await expect(db.account.findUniqueOrThrow({
            where: { id: invitedAccount.id },
            select: { homeRole: true },
        })).resolves.toEqual({ homeRole: "member" });
        await expect(db.team.count()).resolves.toBe(1);
    });

    it("reuses the default Team after Home ownership transfers to another Account", async () => {
        const initialOwner = await createAccount();
        const initialized = await bootstrap();
        if (initialized.status !== "ready") throw new Error(`Unexpected bootstrap result: ${initialized.status}`);
        const nextOwner = await createAccount();

        const promoted = await inTx(async (tx) => await setHomeRoleInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: initialOwner.id,
            targetAccountId: nextOwner.id,
            homeRole: "owner",
            env: PERSONAL_HOME_ENV,
        }));
        expect(promoted.status).toBe("ok");
        const demoted = await inTx(async (tx) => await setHomeRoleInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: nextOwner.id,
            targetAccountId: initialOwner.id,
            homeRole: "member",
            env: PERSONAL_HOME_ENV,
        }));
        expect(demoted.status).toBe("ok");

        await expect(bootstrap()).resolves.toEqual({
            status: "ready",
            teamId: initialized.teamId,
        });
        await expect(db.team.count()).resolves.toBe(1);
    });

    it("uses the one active Home owner when other active members already exist", async () => {
        const owner = await createAccount({ homeRole: "owner" });
        const member = await createAccount();

        const initialized = await bootstrap();

        if (initialized.status !== "ready") throw new Error(`Unexpected bootstrap result: ${initialized.status}`);
        await expect(db.teamMembership.findMany({
            where: { teamId: initialized.teamId },
            select: { accountId: true, role: true },
        })).resolves.toEqual([{ accountId: owner.id, role: "owner" }]);
        await expect(db.account.findUniqueOrThrow({
            where: { id: member.id },
            select: { homeRole: true },
        })).resolves.toEqual({ homeRole: "member" });
    });

    it("reports setup required instead of choosing among multiple ownerless active Accounts", async () => {
        await createAccount();
        await createAccount();

        await expect(bootstrap()).resolves.toEqual({ status: "setup_required" });

        await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
        await expect(db.team.count()).resolves.toBe(0);
    });

    it("reports setup required instead of choosing among multiple active Home owners", async () => {
        await createAccount({ homeRole: "owner" });
        await createAccount({ homeRole: "owner" });

        await expect(bootstrap()).resolves.toEqual({ status: "setup_required" });

        await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
        await expect(db.team.count()).resolves.toBe(0);
    });

    it("keeps the initialized Team when HOME later supplies different display copy", async () => {
        await createAccount();
        const initialized = await bootstrap();
        if (initialized.status !== "ready") throw new Error(`Unexpected bootstrap result: ${initialized.status}`);

        await expect(bootstrap({ defaultTeamName: "A newer product name" })).resolves.toEqual({
            status: "ready",
            teamId: initialized.teamId,
        });
        await expect(db.team.findUniqueOrThrow({
            where: { id: initialized.teamId },
            select: { name: true },
        })).resolves.toEqual({ name: "My Team" });
        await expect(db.team.count()).resolves.toBe(1);
    });

    it("does not report an initialized Team ready when Teams later becomes unavailable", async () => {
        await createAccount();
        const initialized = await bootstrap();
        if (initialized.status !== "ready") throw new Error(`Unexpected bootstrap result: ${initialized.status}`);
        const policyBefore = await db.homeGovernancePolicy.findUniqueOrThrow({
            where: { id: HOME_GOVERNANCE_POLICY_ID },
            select: { revision: true, teamCreationPolicy: true, authenticationPolicy: true },
        });
        const teamBefore = await db.team.findUniqueOrThrow({
            where: { id: initialized.teamId },
            select: { name: true, admissionMode: true },
        });

        await expect(bootstrap({
            defaultTeamName: "A newer product name",
            env: {
                ...PERSONAL_HOME_ENV,
                HAPPIER_BUILD_FEATURES_DENY: "teams",
            },
        })).resolves.toEqual({ status: "teams_unavailable" });

        await expect(db.homeGovernancePolicy.findUniqueOrThrow({
            where: { id: HOME_GOVERNANCE_POLICY_ID },
            select: { revision: true, teamCreationPolicy: true, authenticationPolicy: true },
        })).resolves.toEqual(policyBefore);
        await expect(db.team.findUniqueOrThrow({
            where: { id: initialized.teamId },
            select: { name: true, admissionMode: true },
        })).resolves.toEqual(teamBefore);
        await expect(db.team.count()).resolves.toBe(1);
        await expect(db.teamMembership.count()).resolves.toBe(1);
    });

    it("creates the bootstrap Team even when unrelated user-created Teams already exist", async () => {
        const account = await createAccount({ homeRole: "owner" });
        const existing = await inTx((tx) => createTeamInTx(tx, {
            actorAccountId: account.id,
            name: "Existing Team",
            initialOwnerAccountId: account.id,
            requestKey: crypto.randomUUID(),
            env: PERSONAL_HOME_ENV,
        }));
        expect(existing.ok).toBe(true);

        const initialized = await bootstrap();

        expect(initialized.status).toBe("ready");
        if (!existing.ok || initialized.status !== "ready") return;
        expect(initialized.teamId).not.toBe(existing.team.id);
        await expect(db.team.count()).resolves.toBe(2);
    });

    it("rolls back owner and policy writes when Team creation cannot complete", async () => {
        const account = await createAccount();

        await expect(bootstrap({
            env: {
                ...PERSONAL_HOME_ENV,
                HAPPIER_BUILD_FEATURES_DENY: "teams",
            },
        })).resolves.toEqual({ status: "teams_unavailable" });

        await expect(db.account.findUniqueOrThrow({ where: { id: account.id }, select: { homeRole: true } }))
            .resolves.toEqual({ homeRole: "member" });
        await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
        await expect(db.team.count()).resolves.toBe(0);
        await expect(db.repeatKey.count()).resolves.toBe(0);
    });

    it("rejects invalid HOME-owned Team copy without retaining partial bootstrap state", async () => {
        const account = await createAccount();

        await expect(bootstrap({ defaultTeamName: "   " }))
            .resolves.toEqual({ status: "invalid_default_team_name" });

        await expect(db.account.findUniqueOrThrow({ where: { id: account.id }, select: { homeRole: true } }))
            .resolves.toEqual({ homeRole: "member" });
        await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
        await expect(db.team.count()).resolves.toBe(0);
    });

    it("does not treat an inactive Account as a bootstrap owner candidate", async () => {
        await createAccount({ status: "disabled" });

        await expect(bootstrap()).resolves.toEqual({ status: "setup_required" });

        await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
        await expect(db.team.count()).resolves.toBe(0);
    });
});
