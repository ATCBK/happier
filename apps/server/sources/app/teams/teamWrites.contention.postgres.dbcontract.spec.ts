import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { HOME_GOVERNANCE_POLICY_ID } from "@/app/home/governance/governancePolicy";
import { createQualifiedConnectedAccountGroupDigest, createQualifiedConnectedAccountServiceDigest } from "@/app/api/routes/connect/qualifiedConnectedAccounts/identity";
import { initEncrypt } from "@/modules/encrypt";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, readPostgresTransactionSqlState, type Tx } from "@/storage/inTx";
import { registerTeamRoutes } from "./registerTeamRoutes";
import { registerTeamMemberRoutes } from "./memberships/registerTeamMemberRoutes";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Team write contention (PostgreSQL)", () => {
    const accountIds: string[] = [];
    const teamIds: string[] = [];
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    let connected = false;
    const previousEnv = new Map<string, string | undefined>();

    beforeAll(async () => {
        // The runner creates this URL; never fall back to retained development data.
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error("Use the disposable PostgreSQL DB-contract harness");
        for (const [key, value] of Object.entries({
            HANDY_MASTER_SECRET: "fix-c74-disposable-test",
            HAPPIER_FEATURE_TEAMS__ENABLED: "1",
            HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: "1",
        })) {
            previousEnv.set(key, process.env[key]);
            process.env[key] = value;
        }
        await initEncrypt();
        initDbPostgres();
        await db.$connect();
        connected = true;
        await db.homeGovernancePolicy.upsert({
            where: { id: HOME_GOVERNANCE_POLICY_ID },
            create: { id: HOME_GOVERNANCE_POLICY_ID, revision: 1, teamCreationPolicy: "self_service" },
            update: { teamCreationPolicy: "self_service" },
        });
        app = createAuthenticatedTestApp();
        registerTeamRoutes(app);
        registerTeamMemberRoutes(app);
        await app.ready();
    });

    afterAll(async () => {
        if (app) await app.close();
        if (connected) {
            await db.team.deleteMany({ where: { id: { in: teamIds } } });
            await db.machine.deleteMany({ where: { accountId: { in: accountIds } } });
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
            await db.$disconnect();
        }
        for (const [key, value] of previousEnv) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    async function account() {
        const row = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        accountIds.push(row.id);
        return row;
    }

    async function fixture(kind: "create" | "member" | "provider_resource" | "pool_resource") {
        const owner = await account();
        if (kind === "create") return {
            owner, url: "/v1/teams/create", payload: { v: 1, name: "Contended Team", requestKey: randomUUID() },
            verify: async (body: { id: string }) => {
                teamIds.push(body.id);
                expect(await db.teamMembership.findUniqueOrThrow({ where: {
                    teamId_accountId: { teamId: body.id, accountId: owner.id },
                } })).toMatchObject({ role: "owner", status: "active" });
            },
        };
        const team = await db.team.create({ data: { name: "Contended membership and credentials" } });
        teamIds.push(team.id);
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        if (kind === "member") {
            const target = await account();
            return {
                owner, url: "/v1/teams/members/add",
                payload: { v: 1, teamId: team.id, accountId: target.id, role: "member", historyAccess: "all_existing" },
                verify: async (body: { id: string }) => {
                    expect(await db.teamMembership.findUniqueOrThrow({ where: { id: body.id } }))
                        .toMatchObject({ teamId: team.id, accountId: target.id, role: "member", status: "active" });
                },
            };
        }
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, metadata: "{}", kind: "persistent",
            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const service = { pluginId: "example.fix-c74", localId: "accounts" };
        const groupId = randomUUID();
        const group = await db.connectedServiceAuthGroup.create({ data: {
            accountId: owner.id, servicePluginId: service.pluginId, serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }),
            groupId, displayName: "Contended Connected Pool", policyJson: "{}",
        } });
        const source = kind === "pool_resource" ? {
            v: 1, kind: "connected_pool", target: { kind: "group", service, groupId }, poolIncarnation: group.id,
        } : {
            v: 1, kind: "provider_connection", connectionId: `source-${randomUUID()}`,
            connectionSecurityFingerprint: `connection-security:v1:${"r".repeat(43)}`, credentialSlotId: "apiKey",
        };
        const resourceId = randomUUID();
        return {
            owner, url: "/v1/teams/credential-resources/create", payload: {
                teamId: team.id, resourceId, displayName: "Contended broker resource", source,
                disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed",
                brokerPlacement: { kind: "machine", machineId: machine.id }, requestPolicy: null,
                allMembersDeliveryMode: "brokered", groupGrants: [], memberGrants: [], usageLimits: [],
            },
            verify: async (body: { id: string }) => {
                expect(body.id).toBe(resourceId);
                expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: resourceId } }))
                    .toMatchObject({ teamId: team.id, custodianAccountId: owner.id, sourceBindingJson: JSON.stringify(source) });
            },
        };
    }

    it("keeps one Team when the same creation intent arrives during its dedupe read", async () => {
        const input = await fixture("create");
        const original = db.$transaction;
        const competitorScope = new AsyncLocalStorage<boolean>();
        let scheduled = false;
        const post = async () => await app.inject({ method: "POST", url: input.url,
            headers: { "x-test-user-id": input.owner.id }, payload: input.payload });
        let competitor: ReturnType<typeof post> | undefined;
        let competitorOutcome: Promise<PromiseSettledResult<Awaited<ReturnType<typeof post>>>[]> | undefined;
        let ready!: (pid: number) => void;
        const started = new Promise<number>(resolve => { ready = resolve; });
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            const isCompetitor = competitorScope.getStore();
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                if (isCompetitor) {
                    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                    ready(pid);
                    return callback(tx);
                }
                const dedupe = new Proxy(tx.repeatKey, { get(owner, property, receiver) {
                    if (property !== "findUnique") return Reflect.get(owner, property, receiver);
                    return async (...values: Parameters<typeof owner.findUnique>) => {
                        const found = await owner.findUnique(...values);
                        if (!scheduled && found === null) {
                            scheduled = true;
                            let settled = false;
                            competitor = competitorScope.run(true, post);
                            competitorOutcome = Promise.allSettled([competitor]).finally(() => { settled = true; });
                            const pid = await Promise.race([started, competitor.then(() => { throw new Error("Creation missed rendezvous"); })]);
                            while (!settled) {
                                const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                                    SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked
                                `;
                                if (blocked) break;
                            }
                        }
                        return found;
                    };
                } });
                return callback(new Proxy(tx, { get(owner, property, receiver) {
                    return property === "repeatKey" ? dedupe : Reflect.get(owner, property, receiver);
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            const first = await post();
            expect(first.statusCode, first.body).toBe(200);
            teamIds.push(first.json().id);
            if (!competitor) throw new Error("Creation did not reach the dedupe boundary");
            const second = await competitor;
            expect(second.statusCode, second.body).toBe(200);
            teamIds.push(second.json().id);
            expect(second.json().id).toBe(first.json().id);
            expect(await db.teamMembership.count({ where: { accountId: input.owner.id } })).toBe(1);
        } finally {
            db.$transaction = original;
            if (competitorOutcome) await competitorOutcome;
        }
    });

    for (const competition of ["same-account-publication", "foreign-serializable"] as const) {
        it.each(["create", "member", "provider_resource", "pool_resource"] as const)(`%s commits with ${competition}`, async kind => {
            const input = await fixture(kind);
            const foreign = await account();
            await db.$executeRaw`ANALYZE "Account"`;
            const original = db.$transaction;
            const peerScope = new AsyncLocalStorage<boolean>();
            const peers: Promise<unknown>[] = [];
            let competitions = 0;
            // Observe only the genuine Prisma boundary. Routes, services, admission,
            // terminal publication, SQL isolation and error projection remain real.
            db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== "function" || peerScope.getStore()) return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => {
                    let scheduled = false;
                    const query = tx.$queryRawUnsafe.bind(tx);
                    const observed = new Proxy(tx, { get(owner, property, receiver) {
                        if (property !== "$queryRawUnsafe") return Reflect.get(owner, property, receiver);
                        return async (...values: Parameters<typeof query>) => {
                            if (!scheduled && competition === "same-account-publication"
                                && values[0].includes('FROM "Account"') && values[0].endsWith("FOR NO KEY UPDATE")) {
                                scheduled = true;
                                let ready!: (pid: number) => void;
                                const started = new Promise<number>(resolve => { ready = resolve; });
                                let settled = false;
                                const peer = peerScope.run(true, () => inTx(async writer => {
                                    const [{ pid }] = await writer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                                    ready(pid);
                                    await markAccountChanged(writer, { accountId: input.owner.id, kind: "account", entityId: "fix-c74-peer" });
                                }));
                                peers.push(peer);
                                void peer.finally(() => { settled = true; }).catch(() => undefined);
                                const pid = await Promise.race([started, peer.then(() => { throw new Error("Publication missed rendezvous"); })]);
                                while (!settled) {
                                    const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                                        SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked
                                    `;
                                    if (blocked) break;
                                }
                                competitions++;
                            }
                            return query(...values);
                        };
                    } });
                    try {
                        const result = await callback(observed);
                        if (competition === "foreign-serializable") {
                            await original.call(db, async writer => {
                                await writer.account.findUniqueOrThrow({ where: { id: foreign.id } });
                                await writer.account.update({ where: { id: foreign.id }, data: { seq: { increment: 1 } } });
                            }, { isolationLevel: "Serializable" });
                            competitions++;
                        }
                        return result;
                    } catch (error) {
                        console.info("FIX_C74_TX_ROLLBACK", { kind, competition, sqlState: readPostgresTransactionSqlState(error) });
                        throw error;
                    }
                }, ...args.slice(1)]);
            } });
            try {
                const response = await app.inject({ method: "POST", url: input.url,
                    headers: { "x-test-user-id": input.owner.id }, payload: input.payload });
                expect(response.statusCode, response.body).toBe(200);
                await input.verify(response.json());
                expect(competitions).toBeGreaterThan(0);
                // A lost response can replay each public operation without a
                // duplicate Team, membership lifetime or resource identity.
                const repeated = await app.inject({ method: "POST", url: input.url,
                    headers: { "x-test-user-id": input.owner.id }, payload: input.payload });
                expect(repeated.statusCode, repeated.body).toBe(200);
                expect(repeated.json().id).toBe(response.json().id);
            } finally {
                db.$transaction = original;
                const outcomes = await Promise.allSettled(peers);
                expect(outcomes.filter(result => result.status === "rejected")).toEqual([]);
            }
        });
    }
});
