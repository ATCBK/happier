import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { acquireAccountChangePublicationLocksInTx, markAccountChanged } from "@/app/changes/markAccountChanged";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { initEncrypt } from "@/modules/encrypt";
import { withAuthenticatedTestApp as withAuthenticatedAppHarness } from "@/app/api/testkit/sqliteFastify";
import type { Fastify } from "@/app/api/types";
import { QualifiedProviderAccountUsageRecordResponseV4Schema } from "@happier-dev/protocol/connect/qualified-connected-account-projections";
import { ConnectedServiceQuotaSnapshotV1Schema } from "@happier-dev/protocol/connect/connected-service-schemas";
import { buildProviderAccountUsagePageProjectionV1, packProviderAccountUsagePageProjectionV1, PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING } from "@happier-dev/protocol/connect/providerAccountUsagePageProjection";
import { createProviderAccountUsageRecordKey, createUsageSnapshot } from "../providerAccountUsageTestkit";
import { readProviderAccountUsageHistory } from "../providerAccountUsage/recordStorage";
import { mutateQualifiedConnectedServiceCredential } from "./credentialRepository";
import { registerQualifiedConnectedAccountCredentialRoutesV4 } from "./registerQualifiedConnectedAccountCredentialRoutesV4";
import { createQualifiedConnectedAccountGroup, createQualifiedConnectedAccountGroupMember, deleteQualifiedConnectedAccountGroup, deleteQualifiedConnectedAccountGroupMember } from "./groupRepository";
import { resolveLegacyQualifiedConnectedAccountService } from "./identity";
import { projectProviderAccountUsageSnapshotToLegacyQuota } from "./legacyUsageTranslation";
import { requestQualifiedProviderAccountUsageRefresh, writeLegacyConnectedServiceQuotaCompatibilityRecord } from "./usageRepository";

const route = "/v4/connect/qualified/provider-account-usage";
const service = { pluginId: "example.fix88-usage", localId: "external-service" };
// Keep the canonical fixture-auth boundary while retaining Fastify's typed inject result.
const withAuthenticatedTestApp: (
    register: (app: Fastify) => void,
    run: (app: Fastify) => Promise<void>,
) => Promise<void> = withAuthenticatedAppHarness;

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("qualified usage ingestion contention (PostgreSQL)", () => {
    const accountIds: string[] = [];
    let originalDatabaseUrl: string | undefined;
    let previousMasterSecret: string | undefined;
    let connected = false;

    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error("Use the disposable PostgreSQL DB-contract harness");
        originalDatabaseUrl = supplied;
        const url = new URL(supplied);
        url.searchParams.set("application_name", `fix88-usage-${randomUUID()}`);
        process.env.DATABASE_URL = url.toString();
        previousMasterSecret = process.env.HANDY_MASTER_SECRET;
        process.env.HANDY_MASTER_SECRET ??= "fix88-usage-disposable-contract";
        await initEncrypt();
        initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (connected) {
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
            await db.$disconnect();
        }
        if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl;
        if (previousMasterSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
        else process.env.HANDY_MASTER_SECRET = previousMasterSecret;
    });

    async function fixture(credentialService = service) {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        accountIds.push(account.id);
        const ref = { service: credentialService, accountId: randomUUID() };
        const providerAccountId = randomUUID();
        const credential = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id, ref, expectedCredentialRevision: null, authenticationModeId: "api-key",
            content: { t: "plain", v: { token: "disposable-test-token" } },
            metadata: { scopes: [], providerIdentity: { accountId: providerAccountId } },
        });
        if (credential.status !== "written") throw new Error("Expected credential create");
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() - 10_000,
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: providerAccountId }) });
        const payload = {
            source: { ref, bindingKind: "account" as const },
            expectedCredentialRevision: credential.credentialRevision, expectedConfigurationRevision: null,
            recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: "plain_json_v1" as const,
            status: "ok" as const, fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, snapshot,
        };
        return { account, payload, headers: { "x-test-user-id": account.id } };
    }

    async function additionalSource(input: Awaited<ReturnType<typeof fixture>>) {
        const ref = { service, accountId: randomUUID() };
        const credential = await mutateQualifiedConnectedServiceCredential({ accountId: input.account.id, ref,
            expectedCredentialRevision: null, authenticationModeId: "api-key", content: { t: "plain", v: { token: "second-disposable-token" } },
            metadata: { scopes: [], providerIdentity: { accountId: input.payload.recordKey.accountSubjectId } } });
        if (credential.status !== "written") throw new Error("Expected second credential create");
        return { source: { ref, bindingKind: "account" as const }, expectedCredentialRevision: credential.credentialRevision };
    }

    async function groupSource(input: Awaited<ReturnType<typeof fixture>>) {
        const groupId = randomUUID();
        const created = await createQualifiedConnectedAccountGroup({ accountId: input.account.id, service, group: { groupId } });
        if (created.status !== "written") throw new Error("Expected group create");
        const joined = await createQualifiedConnectedAccountGroupMember({ accountId: input.account.id,
            mutation: { group: { service, groupId }, connectedAccountId: input.payload.source.ref.accountId,
                expectedGeneration: created.group.generation, priority: 0 } });
        if (joined.status !== "written") throw new Error("Expected group member create");
        return {
            source: { ref: input.payload.source.ref, bindingKind: "group_member" as const, groupId, groupGeneration: joined.group.generation },
            remove: () => deleteQualifiedConnectedAccountGroupMember({ accountId: input.account.id,
                expectedIncarnation: joined.group.incarnation,
                mutation: { group: { service, groupId }, connectedAccountId: input.payload.source.ref.accountId,
                    expectedGeneration: joined.group.generation, expectedRuntimeStateRevision: joined.group.runtimeStateRevision } }),
            removeGroup: () => deleteQualifiedConnectedAccountGroup({ accountId: input.account.id, service, groupId,
                expectedIncarnation: joined.group.incarnation, expectedGeneration: joined.group.generation,
                expectedRuntimeStateRevision: joined.group.runtimeStateRevision }),
        };
    }

    /** Observe only the real Prisma boundary; all route, admission, merge and SQL logic stays real. */
    async function observeTransactions<T>(observe: (tx: Tx) => void, run: () => T): Promise<Awaited<T>> {
        const original = db.$transaction.bind(db);
        db.$transaction = (async <R>(callback: (tx: Tx) => Promise<R>, options?: { isolationLevel?: "Serializable" | "RepeatableRead" | "ReadCommitted"; timeout?: number; maxWait?: number }) =>
            original(async tx => { observe(tx); return await callback(tx); }, options)) as typeof db.$transaction;
        try { return await run(); }
        finally { db.$transaction = original; }
    }

    /** Continue once the competitor commits or PostgreSQL proves it waits on this transaction. */
    async function commitOrBlock(tx: Tx, write: () => Promise<unknown>, pending: Promise<unknown>[]) {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        let settled = false;
        const competitor = write().finally(() => { settled = true; });
        // Attach immediately; the original promise is still asserted below and after commit.
        void competitor.catch(() => undefined);
        pending.push(competitor);
        while (!settled) {
            const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                    WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
            `;
            if (blocked) return;
        }
        await competitor;
    }

    it("commits ordinary usage while another content writer is in domain work and preserves terminal cursors", async () => {
        const { account, payload, headers } = await fixture();
        const before = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
        const pending: Promise<unknown>[] = [];
        let usageCommittedDuringDomain = false;
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            await inTx(async peer => {
                await acquireAccountChangePublicationLocksInTx(peer, [account.id], { intent: "content" });
                await commitOrBlock(peer, async () => {
                    const response = await app.inject({ method: "POST", url: route, headers, payload });
                    expect(response.statusCode, response.body).toBe(200);
                    usageCommittedDuringDomain = true;
                }, pending);
                if (usageCommittedDuringDomain) {
                    const usage = await db.accountChange.findUniqueOrThrow({ where: {
                        accountId_kind_entityId: { accountId: account.id, kind: "account", entityId: "provider-account-usage" },
                    } });
                    expect(usage.cursor).toBe(before.seq + 1);
                    expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(usage.cursor);
                }
                await markAccountChanged(peer, { accountId: account.id, kind: "account", entityId: "dbperf-content-peer" });
            });
            await Promise.all(pending);
        });
        expect(usageCommittedDuringDomain, "Ordinary usage must not wait for compatible content admission").toBe(true);
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(before.seq + 2);
        expect(await db.providerAccountUsageHistory.count({ where: { accountId: account.id } })).toBe(1);
        expect(await db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: "account", entityId: "dbperf-content-peer" },
        } })).toMatchObject({ cursor: before.seq + 2 });
    });

    it.each(["projection", "observation"] as const)("does not read back the packed history body after a %s write", async kind => {
        const { account, payload, headers } = await fixture();
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const seeded = await app.inject({ method: "POST", url: route, headers, payload });
            expect(seeded.statusCode, seeded.body).toBe(200);
            const range = { startAtMs: payload.fetchedAt, endAtMs: payload.fetchedAt + 2000 };
            const history = await readProviderAccountUsageHistory({ accountId: account.id, recordId: payload.recordId,
                history: { range, pageSize: 100 } });
            const witness = history.entries[0]!;
            const projection = { recordId: payload.recordId, encoding: PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING,
                demand: { range, resolution: "accepted_observations" as const },
                frontier: { id: witness.id, observedAtMs: witness.observedAtMs }, observationCount: 1,
                content: { t: "plain" as const, v: packProviderAccountUsagePageProjectionV1(buildProviderAccountUsagePageProjectionV1({
                    recordId: payload.recordId, range,
                    history: { entries: [{ id: witness.id, observedAtMs: witness.observedAtMs, snapshot: payload.snapshot }], nextCursor: null },
                })) } };
            const put = () => app.inject({ method: "PUT", url: `${route}/history`, headers, payload: projection });
            if (kind === "observation") expect((await put()).statusCode).toBe(200);
            const returned: object[] = [];
            const snapshot = createUsageSnapshot({ fetchedAt: payload.fetchedAt + 1000, recordKey: payload.recordKey,
                planLabel: "changed observation" });
            const response = await observeTransactions(tx => {
                // Observe the real PostgreSQL response, not a mocked repository.
                // Returning metadata transfers the whole packed body while the
                // transaction still owns its usage/publication row locks.
                const update = tx.providerAccountUsageRecord.update.bind(tx.providerAccountUsageRecord);
                tx.providerAccountUsageRecord.update = (async (args: Parameters<typeof update>[0]) => {
                    const result = await update(args);
                    returned.push(result);
                    return result;
                // Prisma's generic query thenable is replaced only at this
                // database-observation boundary; awaited results stay real.
                }) as unknown as typeof tx.providerAccountUsageRecord.update;
            }, () => kind === "projection" ? put() : app.inject({ method: "POST", url: route, headers,
                payload: { ...payload, snapshot, fetchedAt: snapshot.fetchedAtMs } }));
            expect(response.statusCode, response.body).toBe(200);
            expect(returned.length).toBeGreaterThan(0);
            expect(returned.some(row => "metadata" in row), "Ignored write results must not transfer the packed history body").toBe(false);
            const stored = await db.providerAccountUsageRecord.findUniqueOrThrow({
                where: { accountId_recordId: { accountId: account.id, recordId: payload.recordId } },
            });
            expect(stored.metadata).toMatchObject({ pageProjection: projection });
            const accepted = await readProviderAccountUsageHistory({ accountId: account.id, recordId: payload.recordId,
                history: { range, pageSize: 100 } });
            expect(accepted.entries.map(entry => entry.record.snapshot?.planLabel))
                .toEqual(kind === "projection" ? [payload.snapshot.planLabel] : [payload.snapshot.planLabel, snapshot.planLabel]);
        });
    });

    it.each(["account", "group_member", "legacy"] as const)("does not retain the credential lock while a %s write waits for exclusive Account authority", async kind => {
        const input = await fixture(kind === "legacy" ? resolveLegacyQualifiedConnectedAccountService("openai-codex") : service);
        const { account, headers } = input;
        const payload = kind === "group_member" ? { ...input.payload, source: (await groupSource(input)).source } : input.payload;
        const credential = await db.serviceAccountToken.findFirstOrThrow({ where: { accountId: account.id } });
        let write: Promise<unknown> | undefined;
        let credentialLockError: unknown;
        let blocked = false;
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            // Credential/mode/lifecycle writers enter exclusively. Inspect the
            // real lock graph before probing the credential, without sleeps or
            // an invented lock timeout. NOWAIT is only this test's observation.
            await db.$transaction(async peer => {
                const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await acquireAccountSessionOwnerMetadataFenceInTx(peer, account.id, "exclusive");
                let settled = false;
                write = (kind === "legacy"
                    ? writeLegacyConnectedServiceQuotaCompatibilityRecord({ accountId: account.id, serviceId: "openai-codex",
                        profileId: payload.source.ref.accountId, payloadMode: "plain_json_v1", status: "ok",
                        fetchedAt: payload.fetchedAt, staleAfterMs: payload.staleAfterMs,
                        snapshot: ConnectedServiceQuotaSnapshotV1Schema.parse(projectProviderAccountUsageSnapshotToLegacyQuota({ serviceId: "openai-codex",
                            profileId: payload.source.ref.accountId, snapshot: payload.snapshot })) })
                    : app.inject({ method: "POST", url: route, headers, payload }).then(response => {
                        expect(response.statusCode, response.body).toBe(200);
                    })).finally(() => { settled = true; });
                void write.catch(() => undefined);
                while (!settled) {
                    const [state] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                            WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
                    `;
                    if (state.blocked) { blocked = true; break; }
                }
                try {
                    await peer.$queryRaw`SELECT "id" FROM "ServiceAccountToken" WHERE "id" = ${credential.id} FOR NO KEY UPDATE NOWAIT`;
                } catch (error) { credentialLockError = error; }
            });
            await write;
        });
        expect(blocked).toBe(true);
        expect(credentialLockError, "Usage must wait for exclusive Account authority before locking the credential").toBeUndefined();
        expect(await db.providerAccountUsageHistory.count({ where: { accountId: account.id } })).toBe(1);
    });

    it("leaves the usage row available while waiting for an exclusive Account authority writer", async () => {
        const { account, payload, headers } = await fixture();
        let write: Promise<unknown> | undefined;
        let usageLockError: unknown;
        let blocked = false;
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const seeded = await app.inject({ method: "POST", url: route, headers, payload });
            expect(seeded.statusCode, seeded.body).toBe(200);
            const snapshot = createUsageSnapshot({ fetchedAt: payload.fetchedAt + 1000, recordKey: payload.recordKey });
            await db.$transaction(async peer => {
                const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await acquireAccountSessionOwnerMetadataFenceInTx(peer, account.id, "exclusive");
                let settled = false;
                write = app.inject({ method: "POST", url: route, headers,
                    payload: { ...payload, snapshot, fetchedAt: snapshot.fetchedAtMs } }).then(response => {
                    expect(response.statusCode, response.body).toBe(200);
                }).finally(() => { settled = true; });
                void write.catch(() => undefined);
                while (!settled) {
                    const [state] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                            WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
                    `;
                    if (state.blocked) { blocked = true; break; }
                }
                try {
                    await peer.$queryRaw`SELECT "id" FROM "ProviderAccountUsageRecord"
                        WHERE "accountId" = ${account.id} AND "recordId" = ${payload.recordId} FOR NO KEY UPDATE NOWAIT`;
                } catch (error) { usageLockError = error; }
            });
            await write;
        });
        expect(blocked).toBe(true);
        expect(usageLockError, "Usage must pass exclusive authority admission before locking its usage row").toBeUndefined();
        expect(await db.providerAccountUsageRecord.findUniqueOrThrow({
            where: { accountId_recordId: { accountId: account.id, recordId: payload.recordId } },
        })).toMatchObject({ fetchedAt: new Date(payload.fetchedAt + 1000) });
    });

    it.each(["account", "group_member"] as const)("ingests and reads a linked %s external-plugin record while the Account cursor changes on every attempt", async kind => {
        const input = await fixture();
        const { account, headers } = input;
        const payload = kind === "account" ? input.payload : { ...input.payload, source: (await groupSource(input)).source };
        const pending: Promise<unknown>[] = [];
        let interleavings = 0;
        try {
            await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
                const response = await observeTransactions(tx => {
                    const find = tx.account.findUnique.bind(tx.account);
                    let observed = false;
                    tx.account.findUnique = (async (args: Parameters<typeof find>[0]) => {
                        const row = await find(args);
                        if (!observed) {
                            observed = true;
                            interleavings++;
                            await commitOrBlock(tx, () => db.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } }), pending);
                        }
                        return row;
                    }) as unknown as typeof tx.account.findUnique;
                }, () => app.inject({ method: "POST", url: route, headers, payload }));
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toEqual({ success: true, source: { status: "linked" } });
                await Promise.all(pending);
                const read = await app.inject({ method: "GET", url: `${route}/record?recordId=${encodeURIComponent(payload.recordId)}`, headers });
                expect(read.statusCode, read.body).toBe(200);
                const consumed = QualifiedProviderAccountUsageRecordResponseV4Schema.parse(read.json());
                expect(consumed).toMatchObject({ content: { t: "plain", v: payload.snapshot }, sources: [payload.source] });
                expect(await db.providerAccountUsageHistory.count({ where: { accountId: account.id, recordId: payload.recordId } })).toBe(1);
            });
        } finally { await Promise.allSettled(pending); }
        expect(interleavings).toBeGreaterThan(0);
    });

    it("preserves the newest subscription when two sources merge the same fetchedAt", async () => {
        const input = await fixture();
        const { account, payload, headers } = input;
        const secondSource = await additionalSource(input);
        const subscription = { status: "subscribed" as const, renewal: "on" as const,
            observedAtMs: payload.fetchedAt, staleAfterMs: 60_000 };
        const pending: Promise<unknown>[] = [];
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const first = await app.inject({ method: "POST", url: route, headers, payload: {
                ...payload, snapshot: { ...payload.snapshot, subscription } } });
            expect(first.statusCode, first.body).toBe(200);
            let observed = false;
            try {
                const response = await observeTransactions(tx => {
                    const find = tx.providerAccountUsageRecord.findUnique.bind(tx.providerAccountUsageRecord);
                    tx.providerAccountUsageRecord.findUnique = (async (args: Parameters<typeof find>[0]) => {
                        const row = await find(args);
                        if (!observed && row && "snapshot" in row) {
                            observed = true;
                            await commitOrBlock(tx, async () => {
                                const second = await app.inject({ method: "POST", url: route, headers, payload: { ...payload,
                                    ...secondSource,
                                    snapshot: { ...payload.snapshot, subscription: { ...subscription, renewal: "off", observedAtMs: subscription.observedAtMs + 2000 } } } });
                                expect(second.statusCode, second.body).toBe(200);
                            }, pending);
                        }
                        return row;
                    }) as unknown as typeof tx.providerAccountUsageRecord.findUnique;
                }, () => app.inject({ method: "POST", url: route, headers, payload: { ...payload,
                    snapshot: { ...payload.snapshot, subscription: { ...subscription, observedAtMs: subscription.observedAtMs + 1000 } } } }));
                expect(response.statusCode, response.body).toBe(200);
                await Promise.all(pending);
                const read = await app.inject({ method: "GET", url: `${route}/record?recordId=${encodeURIComponent(payload.recordId)}`, headers });
                expect(read.statusCode, read.body).toBe(200);
                expect(QualifiedProviderAccountUsageRecordResponseV4Schema.parse(read.json())).toMatchObject({
                    content: { t: "plain", v: { subscription: { renewal: "off", observedAtMs: subscription.observedAtMs + 2000 } } },
                    sources: expect.arrayContaining([payload.source, secondSource.source]),
                });
                const history = await readProviderAccountUsageHistory({ accountId: account.id, recordId: payload.recordId,
                    history: { range: { startAtMs: payload.fetchedAt, endAtMs: payload.fetchedAt + 1 }, pageSize: 100 } });
                expect(history.entries.map(entry => entry.record.snapshot?.subscription)).toEqual([
                    subscription, { ...subscription, renewal: "off", observedAtMs: subscription.observedAtMs + 2000 },
                ]);
                expect(history.nextCursor).toBeNull();
                expect(observed).toBe(true);
            } finally { await Promise.allSettled(pending); }
        });
    });

    it("settles concurrent first observations without leaving PostgreSQL in an aborted transaction", async () => {
        const input = await fixture();
        const { account, payload, headers } = input;
        const secondSource = await additionalSource(input);
        const pending: Promise<unknown>[] = [];
        let observed = false;
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            try {
                const response = await observeTransactions(tx => {
                    const find = tx.providerAccountUsageRecord.findUnique.bind(tx.providerAccountUsageRecord);
                    tx.providerAccountUsageRecord.findUnique = (async (args: Parameters<typeof find>[0]) => {
                        const row = await find(args);
                        if (!observed && !row) {
                            observed = true;
                            await commitOrBlock(tx, async () => {
                                const second = await app.inject({ method: "POST", url: route, headers, payload: { ...payload, ...secondSource } });
                                expect(second.statusCode, second.body).toBe(200);
                            }, pending);
                        }
                        return row;
                    }) as unknown as typeof tx.providerAccountUsageRecord.findUnique;
                }, () => app.inject({ method: "POST", url: route, headers, payload }));
                expect(response.statusCode, response.body).toBe(200);
                await Promise.all(pending);
                const read = await app.inject({ method: "GET", url: `${route}/record?recordId=${encodeURIComponent(payload.recordId)}`, headers });
                expect(read.statusCode, read.body).toBe(200);
                expect(QualifiedProviderAccountUsageRecordResponseV4Schema.parse(read.json())).toMatchObject({
                    content: { t: "plain", v: payload.snapshot }, sources: expect.arrayContaining([payload.source, secondSource.source]),
                });
                expect(await db.providerAccountUsageHistory.count({ where: { accountId: account.id, recordId: payload.recordId } })).toBe(1);
                expect(observed).toBe(true);
            } finally { await Promise.allSettled(pending); }
        });
    });

    it("rejects a source bound to another provider identity and a stale credential revision without retaining observations", async () => {
        const { account, payload, headers } = await fixture();
        const wrong = createUsageSnapshot({ fetchedAt: payload.fetchedAt,
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: randomUUID() }) });
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const misbound = await app.inject({ method: "POST", url: route, headers,
                payload: { ...payload, recordId: wrong.recordId, recordKey: wrong.recordKey, snapshot: wrong } });
            expect(misbound.statusCode, misbound.body).toBe(400);
            const stale = await app.inject({ method: "POST", url: route, headers,
                payload: { ...payload, expectedCredentialRevision: `csr_${randomUUID().replace(/-/g, "")}` } });
            expect(stale.statusCode, stale.body).toBe(409);
            expect(stale.json()).toMatchObject({ error: "connect_credential_mutation_superseded", reason: "credential_revision_mismatch" });
            expect(await db.providerAccountUsageRecord.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.providerAccountUsageHistory.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.connectedServiceUsageSource.count({ where: { accountId: account.id } })).toBe(0);
        });
    });

    it("does not resurrect a group source after its admitted membership is removed", async () => {
        const input = await fixture();
        const { account, payload, headers } = input;
        const group = await groupSource(input);
        const pending: Promise<unknown>[] = [];
        let observed = false;
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const seeded = await app.inject({ method: "POST", url: route, headers, payload });
            expect(seeded.statusCode, seeded.body).toBe(200);
            try {
                const response = await observeTransactions(tx => {
                    const find = tx.connectedServiceUsageSource.findFirst.bind(tx.connectedServiceUsageSource);
                    tx.connectedServiceUsageSource.findFirst = (async (args: Parameters<typeof find>[0]) => {
                        const row = await find(args);
                        if (!observed) {
                            observed = true;
                            await commitOrBlock(tx, async () => {
                                expect(await group.remove()).toMatchObject({ status: "written" });
                            }, pending);
                        }
                        return row;
                    }) as unknown as typeof tx.connectedServiceUsageSource.findFirst;
                }, () => app.inject({ method: "POST", url: route, headers, payload: { ...payload, source: group.source } }));
                if (response.statusCode === 200) {
                    expect(response.json()).toMatchObject({ source: { status: "skipped", reason: "binding_unavailable" } });
                } else {
                    expect(response.statusCode, response.body).toBe(400);
                }
                await Promise.all(pending);
                expect(await db.connectedServiceUsageSource.count({ where: { accountId: account.id, bindingKind: "group_member" } })).toBe(0);
                expect(observed).toBe(true);
            } finally { await Promise.allSettled(pending); }
        });
    });

    it("finishes admitted usage before credential rotation and refuses later stale usage", async () => {
        const { account, payload, headers } = await fixture();
        const pending: Promise<unknown>[] = [];
        let observed = false;
        let rotationCommitted = false;
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            try {
                const response = await observeTransactions(tx => {
                    const find = tx.account.findUnique.bind(tx.account);
                    tx.account.findUnique = (async (args: Parameters<typeof find>[0]) => {
                        const row = await find(args);
                        if (!observed) {
                            observed = true;
                            await commitOrBlock(tx, async () => {
                                const rotated = await mutateQualifiedConnectedServiceCredential({ accountId: account.id,
                                    ref: payload.source.ref, expectedCredentialRevision: payload.expectedCredentialRevision,
                                    expectedConfigurationRevision: null,
                                    authenticationModeId: "api-key", content: { t: "plain", v: { token: "rotated-disposable-token" } },
                                    metadata: { scopes: [], providerIdentity: { accountId: payload.recordKey.accountSubjectId } } });
                                expect(rotated.status).toBe("written");
                                rotationCommitted = true;
                            }, pending);
                            expect(rotationCommitted, "Exclusive rotation must wait for admitted usage").toBe(false);
                        }
                        return row;
                    }) as unknown as typeof tx.account.findUnique;
                }, () => app.inject({ method: "POST", url: route, headers, payload }));
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ source: { status: "linked" } });
                await Promise.all(pending);
                expect(rotationCommitted).toBe(true);
                const stale = await app.inject({ method: "POST", url: route, headers, payload });
                expect(stale.statusCode, stale.body).toBe(409);
                expect(stale.json()).toMatchObject({ error: "connect_credential_mutation_superseded", reason: "credential_revision_mismatch" });
                expect(await db.providerAccountUsageRecord.count({ where: { accountId: account.id } })).toBe(1);
                expect(await db.providerAccountUsageHistory.count({ where: { accountId: account.id } })).toBe(1);
                expect(observed).toBe(true);
            } finally { await Promise.allSettled(pending); }
        });
    });

    it.each(["member", "group"] as const)("retires the source when %s deletion starts after membership admission is fenced", async kind => {
        const input = await fixture();
        const { account, payload, headers } = input;
        const group = await groupSource(input);
        const pending: Promise<unknown>[] = [];
        let observed = false;
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const seeded = await app.inject({ method: "POST", url: route, headers, payload });
            expect(seeded.statusCode, seeded.body).toBe(200);
            try {
                const response = await observeTransactions(tx => {
                    const update = tx.connectedServiceAuthGroupMember.updateMany.bind(tx.connectedServiceAuthGroupMember);
                    tx.connectedServiceAuthGroupMember.updateMany = (async (args: Parameters<typeof update>[0]) => {
                        const result = await update(args);
                        if (!observed && result.count === 1) {
                            observed = true;
                            await commitOrBlock(tx, async () => {
                                expect(await (kind === "member" ? group.remove() : group.removeGroup()))
                                    .toMatchObject({ status: kind === "member" ? "written" : "deleted" });
                            }, pending);
                        }
                        return result;
                    }) as unknown as typeof tx.connectedServiceAuthGroupMember.updateMany;
                }, () => app.inject({ method: "POST", url: route, headers, payload: { ...payload, source: group.source } }));
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ source: { status: "linked" } });
                await Promise.all(pending);
                expect(await db.connectedServiceUsageSource.count({ where: { accountId: account.id, bindingKind: "group_member" } })).toBe(0);
                const read = await app.inject({ method: "GET", url: `${route}/record?recordId=${encodeURIComponent(payload.recordId)}`, headers });
                expect(read.statusCode, read.body).toBe(200);
                expect(QualifiedProviderAccountUsageRecordResponseV4Schema.parse(read.json())).toMatchObject({ sources: [payload.source] });
                expect(observed).toBe(true);
            } finally { await Promise.allSettled(pending); }
        });
    });

    it("settles a valid observation after more than five concurrent refresh requests within its transaction budget", async () => {
        const input = await fixture();
        const { account, payload, headers } = input;
        let competing = 0;
        let insideCompetitor = false;
        const target = createUsageSnapshot({ fetchedAt: payload.fetchedAt + 1000, recordKey: payload.recordKey, planLabel: "target after burst" });
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const seeded = await app.inject({ method: "POST", url: route, headers, payload });
            expect(seeded.statusCode, seeded.body).toBe(200);
            const response = await observeTransactions(tx => {
                const find = tx.providerAccountUsageRecord.findUnique.bind(tx.providerAccountUsageRecord);
                tx.providerAccountUsageRecord.findUnique = (async (args: Parameters<typeof find>[0]) => {
                    const row = await find(args);
                    if (!insideCompetitor && competing < 6 && row && "snapshot" in row) {
                        competing++;
                        insideCompetitor = true;
                        try {
                            // Publication writers now serialize on Account. The
                            // refresh owner still changes this CAS guard without
                            // publishing an Account cursor, so its interleaving
                            // remains reachable after the first failed CAS.
                            expect(await requestQualifiedProviderAccountUsageRefresh({
                                accountId: account.id, recordId: payload.recordId,
                            })).toBe("written");
                        } finally { insideCompetitor = false; }
                    }
                    return row;
                }) as unknown as typeof tx.providerAccountUsageRecord.findUnique;
            }, () => app.inject({ method: "POST", url: route, headers, payload: { ...payload, snapshot: target, fetchedAt: target.fetchedAtMs } }));
            expect(response.statusCode, response.body).toBe(200);
            expect(competing).toBe(6);
            const read = await app.inject({ method: "GET", url: `${route}/record?recordId=${encodeURIComponent(payload.recordId)}`, headers });
            expect(read.statusCode, read.body).toBe(200);
            expect(QualifiedProviderAccountUsageRecordResponseV4Schema.parse(read.json())).toMatchObject({ content: { t: "plain", v: target } });
            const history = await readProviderAccountUsageHistory({ accountId: account.id, recordId: payload.recordId,
                history: { range: { startAtMs: payload.fetchedAt, endAtMs: target.fetchedAtMs + 1 }, pageSize: 100 } });
            expect(history.entries.map(entry => entry.record.snapshot?.planLabel))
                .toEqual([payload.snapshot.planLabel, "target after burst"]);
            expect(await db.providerAccountUsageRecord.findUniqueOrThrow({
                where: { accountId_recordId: { accountId: account.id, recordId: payload.recordId } },
            })).toMatchObject({ refreshRequestedAt: expect.any(Date) });
        });
    });
});
