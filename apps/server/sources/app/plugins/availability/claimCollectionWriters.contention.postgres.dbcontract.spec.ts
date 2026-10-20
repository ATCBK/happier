import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityCollectionWritersClaimActionOutputV1Schema, PluginAccountCollectionContributionV1Schema, PluginManifestV2Schema, normalizePluginAccountCollectionContractsV1 } from "@happier-dev/protocol";
import { withAuthenticatedTestApp as withAuthenticatedAppHarness } from "@/app/api/testkit/sqliteFastify";
import type { Fastify } from "@/app/api/types";
import { materializePluginCollectionContractsFromManifestTx } from "@/app/plugins/data/collections/contracts";
import { readCurrentPluginCollectionContract } from "@/app/plugins/data/collections/uiQuery";
import { mutatePluginCollection } from "@/app/plugins/data/collections/mutation";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { registerPluginAvailabilityRoutes } from "./routes";
import { resolveCurrentPluginDeclarationsTx } from "./currentDeclaration";
import { createPluginAvailabilityOperations } from "./operations";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { pagePluginCollectionCandidatePreparationSource, stagePluginCollectionCandidatePreparation } from "@/app/plugins/data/collections/candidatePreparation";

const route = PluginAvailabilityActionHttpPathsV1["account.plugins.availability.collectionWriters.claim"];
const withAuthenticatedTestApp: (
    register: (app: Fastify) => void,
    run: (app: Fastify) => Promise<void>,
) => Promise<void> = withAuthenticatedAppHarness;

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Collection writer claim contention (PostgreSQL)", () => {
    const accountIds: string[] = [];
    const pluginIds: string[] = [];
    let connected = false;

    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error("Use the disposable PostgreSQL DB-contract harness");
        // Preserve the production nine attempts; remove only randomized retry sleep.
        vi.stubEnv("HAPPIER_DB_TX_RETRY_BASE_DELAY_MS", "0");
        vi.stubEnv("HAPPIER_DB_TX_RETRY_MAX_DELAY_MS", "0");
        vi.stubEnv("HAPPIER_DB_TX_RETRY_JITTER_FACTOR", "0");
        initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (connected) {
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
            await db.pluginCollectionContract.deleteMany({ where: { pluginId: { in: pluginIds } } });
            await db.$disconnect();
        }
        vi.unstubAllEnvs();
    });

    async function fixture(materialize = true) {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        accountIds.push(account.id);
        const pluginId = `example.fix90-${randomUUID()}`;
        pluginIds.push(pluginId);
        const collection = PluginAccountCollectionContributionV1Schema.parse({
            id: "items", schemaVersion: 1, rowIdField: "id",
            schema: { type: "object", properties: {
                id: { type: "string", maxLength: 256 }, status: { type: "string", enum: ["open", "closed"] },
            }, required: ["id", "status"], additionalProperties: false },
            serverReadable: ["status"], indexes: [{ id: "by-status", fields: [{ field: "status", direction: "asc" }] }], relations: [],
        });
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: pluginId, version: "1.0.0",
            displayName: "External collection claim", engines: { happier: "^1.0.0" }, runtime: { apiVersion: 1 },
            contributes: { accountCollections: [collection] } });
        if (materialize) await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest }));
        const [contract] = normalizePluginAccountCollectionContractsV1({ pluginId, contributions: [collection] });
        const ref = { pluginId, collectionId: contract!.collectionId, schemaVersion: contract!.schemaVersion, contractDigest: contract!.contractDigest };
        return { account, manifest, ref, headers: { "x-test-user-id": account.id } };
    }

    /** Observe the genuine database boundary; route, merge, readiness and publication logic stay real. */
    async function observeTransactions<T>(observe: (tx: Tx) => void, run: () => T): Promise<Awaited<T>> {
        const original = db.$transaction.bind(db);
        db.$transaction = (async <R>(callback: (tx: Tx) => Promise<R>, options?: { isolationLevel?: "Serializable" | "RepeatableRead" | "ReadCommitted"; timeout?: number; maxWait?: number }) =>
            original(async tx => { observe(tx); return await callback(tx); }, options)) as typeof db.$transaction;
        try { return await run(); }
        finally { db.$transaction = original; }
    }

    /** Continue only after the foreign SQL committed or PostgreSQL proves the current transaction fences it. */
    async function commitOrBlock(tx: Tx, write: () => Promise<unknown>, pending: Promise<unknown>[]) {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        let settled = false;
        const competitor = write().finally(() => { settled = true; });
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

    it.each([false, true])("rejoins an unchanged claim without exclusive admission (prepare: %s)", async prepare => {
        const { account, manifest, headers } = await fixture();
        const pending: Promise<unknown>[] = [];
        try {
            await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
                const first = await app.inject({ method: "POST", url: route, headers, payload: { manifest } });
                expect(first.statusCode, first.body).toBe(200);
                const before = await db.account.findUniqueOrThrow({ where: { id: account.id } });
                let completed = false;
                await inTx(async tx => {
                    await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "content");
                    await commitOrBlock(tx, async () => {
                        const response = await app.inject({ method: "POST", url: route, headers,
                            payload: { manifest, ...(prepare ? { prepare: true } : {}) } });
                        expect(response.statusCode, response.body).toBe(200);
                        const result = PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse(response.json());
                        expect(result.intent).toEqual(first.json().intent);
                        if (prepare) expect(result.preparation).toEqual([]);
                        completed = true;
                    }, pending);
                    expect(completed, "An unchanged declaration must not queue an exclusive Account waiter").toBe(true);
                });
                expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(before.seq);
            });
        } finally { await Promise.allSettled(pending); }
    });

    it("pages candidate source content under shared admission while stage writes remain exclusive", async () => {
        const { account, manifest } = await fixture();
        const operations = createPluginAvailabilityOperations();
        await operations.claimCollectionWriters({ accountId: account.id, input: { manifest } });
        const nextManifest = PluginManifestV2Schema.parse({ ...manifest, version: "2.0.0", contributes: {
            accountCollections: [{ ...manifest.contributes.accountCollections[0]!, schemaVersion: 2,
                readableSchemaVersions: [1], migrations: [{ id: "upgrade", fromSchemaVersion: 1, toSchemaVersion: 2 }] }],
        } });
        const prepared = await operations.claimCollectionWriters({ accountId: account.id,
            input: { manifest: nextManifest, prepare: true } });
        const binding = prepared.preparation![0]!.binding;
        const pending: Promise<unknown>[] = [];
        try {
            let paged = false;
            await inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "content");
                await commitOrBlock(tx, async () => {
                    expect(await pagePluginCollectionCandidatePreparationSource({ accountId: account.id,
                        request: { binding, limit: 10 } })).toMatchObject({ rows: [] });
                    paged = true;
                }, pending);
                expect(paged, "A source-page read must not queue an exclusive Account waiter").toBe(true);
                let staged = false;
                await commitOrBlock(tx, async () => {
                    await stagePluginCollectionCandidatePreparation({ accountId: account.id,
                        request: { binding, items: [{ source: { rowId: "absent", revision: 1 },
                            target: { content: { t: "plain", v: {} }, projection: { status: "open" } } }] } });
                    staged = true;
                }, pending);
                expect(staged, "Quota-affecting stage writes must still wait for content admission").toBe(false);
            });
            await Promise.all(pending);
        } finally { await Promise.allSettled(pending); }
    });

    it("prepares a new candidate without exclusively admitting a quota mutation", async () => {
        const { account, manifest, headers } = await fixture();
        const pending: Promise<unknown>[] = [];
        try {
            await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
                const first = await app.inject({ method: "POST", url: route, headers, payload: { manifest } });
                expect(first.statusCode, first.body).toBe(200);
                const nextManifest = PluginManifestV2Schema.parse({ ...manifest, version: "2.0.0", contributes: {
                    accountCollections: [{ ...manifest.contributes.accountCollections[0]!, schemaVersion: 2,
                        readableSchemaVersions: [1], migrations: [{ id: "upgrade", fromSchemaVersion: 1, toSchemaVersion: 2 }] }],
                } });
                let prepared = false;
                await inTx(async tx => {
                    await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "content");
                    await commitOrBlock(tx, async () => {
                        const response = await app.inject({ method: "POST", url: route, headers,
                            payload: { manifest: nextManifest, prepare: true } });
                        expect(response.statusCode, response.body).toBe(200);
                        const result = PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse(response.json());
                        expect(result.intent).toEqual(first.json().intent);
                        expect(result.preparation).toHaveLength(1);
                        prepared = true;
                    }, pending);
                    expect(prepared, "Preparation only reads the incumbent and materializes immutable contracts").toBe(true);
                });
            });
        } finally { await Promise.allSettled(pending); }
    });

    it("claims through HTTP and admits the exact Data writer despite a foreign Account cursor write on every attempt", async () => {
        const { account, manifest, ref, headers } = await fixture();
        const pending: Promise<unknown>[] = [];
        let interleavings = 0;
        let cursorCommittedDuringMaterialization = false;
        try {
            await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
                const response = await observeTransactions(tx => {
                    const find = tx.pluginCollectionContract.findFirst.bind(tx.pluginCollectionContract);
                    let observed = false;
                    tx.pluginCollectionContract.findFirst = (async (args: Parameters<typeof find>[0]) => {
                        const row = await find(args);
                        if (!observed) {
                            observed = true;
                            interleavings++;
                            // This writer intentionally bypasses this release's inTx/fence
                            // to represent another server running older code.
                            let committed = false;
                            await commitOrBlock(tx, async () => {
                                await db.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                                committed = true;
                            }, pending);
                            cursorCommittedDuringMaterialization = committed;
                        }
                        return row;
                    }) as unknown as typeof tx.pluginCollectionContract.findFirst;
                }, () => app.inject({ method: "POST", url: route, headers, payload: { manifest } }));
                expect(response.statusCode, `${response.body}; observed attempts=${interleavings}`).toBe(200);
                const output = PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse(response.json());
                expect(output.intent).toMatchObject({ pluginId: manifest.id, desiredVersion: null, writableCollections: [ref], revision: "0" });
                await Promise.all(pending);
                await expect(readCurrentPluginCollectionContract({ accountId: account.id, request: { ref } }))
                    .resolves.toMatchObject({ access: "writable", contract: { contractDigest: ref.contractDigest } });
                expect(await db.accountPluginIntent.count({ where: { accountId: account.id, pluginId: manifest.id } })).toBe(1);
                expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(account.seq + interleavings + 1);
                await expect(readCurrentPluginCollectionContract({ accountId: account.id,
                    request: { ref: { ...ref, pluginId: "example.misbound" } } })).rejects.toMatchObject({ code: "collection_unavailable" });
            });
        } finally { await Promise.allSettled(pending); }
        expect(interleavings).toBeGreaterThan(0);
        // Immutable global contract preparation must not occupy the Account's
        // publication critical section. Mutable intent/quota reads remain fenced.
        expect(cursorCommittedDuringMaterialization).toBe(true);
    });

    it("merges concurrent first claims and retains the newer declaration when the older daemon rejoins", async () => {
        const { account, manifest, ref, headers } = await fixture();
        const newerManifest = PluginManifestV2Schema.parse({ ...manifest, version: "2.0.0", contributes: {
            accountCollections: [{ ...manifest.contributes.accountCollections[0]!, id: "other-items" }],
        } });
        const [newerRef] = await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest: newerManifest }));
        const pending: Promise<unknown>[] = [];
        let observed = false;
        try {
            await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
                const claim = (claimedManifest: typeof manifest) => app.inject({ method: "POST", url: route, headers, payload: { manifest: claimedManifest } });
                const first = await observeTransactions(tx => {
                    const find = tx.accountPluginIntent.findUnique.bind(tx.accountPluginIntent);
                    tx.accountPluginIntent.findUnique = (async (args: Parameters<typeof find>[0]) => {
                        const current = await find(args);
                        if (!observed) {
                            observed = true;
                            await commitOrBlock(tx, async () => {
                                const peer = await claim(newerManifest);
                                expect(peer.statusCode, peer.body).toBe(200);
                                PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse(peer.json());
                            }, pending);
                        }
                        return current;
                    }) as unknown as typeof tx.accountPluginIntent.findUnique;
                }, () => claim(manifest));
                expect(first.statusCode, first.body).toBe(200);
                await Promise.all(pending);
                const lagging = await claim(manifest);
                expect(lagging.statusCode, lagging.body).toBe(200);
                expect(PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse(lagging.json()).intent)
                    .toMatchObject({ revision: "1", writableCollections: [ref, newerRef] });
                for (const expected of [ref, newerRef!]) {
                    await expect(readCurrentPluginCollectionContract({ accountId: account.id, request: { ref: expected } }))
                        .resolves.toMatchObject({ access: "writable" });
                }
                const declarations = await inTx(tx => resolveCurrentPluginDeclarationsTx({ tx, accountId: account.id,
                    refs: [{ pluginId: manifest.id, version: manifest.version }, { pluginId: newerManifest.id, version: newerManifest.version }] }));
                expect([...declarations.values()].map(value => value.manifest.version)).toEqual([newerManifest.version]);
            });
        } finally { await Promise.allSettled(pending); }
        expect(observed).toBe(true);
    });

    it("retains a present-user release selection and confines the claim to its authenticated Account", async () => {
        const { account, manifest, ref, headers } = await fixture();
        const operations = createPluginAvailabilityOperations();
        await operations.publishRelease({ accountId: account.id, input: { sourceClass: "registryPackage", facts: {
            ref: { pluginId: manifest.id, version: manifest.version }, archiveDigestSha256: `sha256:${"a".repeat(64)}`,
            normalizedManifest: manifest, collectionContracts: [ref], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${"b".repeat(64)}`, resources: [] },
        } } });
        await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
            const first = await app.inject({ method: "POST", url: route, headers, payload: { manifest } });
            expect(first.statusCode, first.body).toBe(200);
            const selected = await app.inject({ method: "POST", url: PluginAvailabilityActionHttpPathsV1["account.plugins.availability.intent.set"], headers,
                payload: { pluginId: manifest.id, desiredVersion: manifest.version, enabled: true,
                    offlineUiHosting: "disabled", writableCollections: [ref], expectedRevision: "0" } });
            expect(selected.statusCode, selected.body).toBe(200);
            const refused = await app.inject({ method: "POST", url: route, headers,
                payload: { manifest: { ...manifest, version: "2.0.0" } } });
            expect(refused.statusCode, refused.body).toBe(409);
            expect(refused.json()).toEqual({ error: "plugin_intent_release_selected" });
            expect(await db.accountPluginIntent.findUniqueOrThrow({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } } }))
                .toMatchObject({ desiredVersion: manifest.version, revision: BigInt(1) });
            const unauthenticated = await app.inject({ method: "POST", url: route, payload: { manifest } });
            expect(unauthenticated.statusCode).toBe(401);
            const outsider = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
            accountIds.push(outsider.id);
            await expect(readCurrentPluginCollectionContract({ accountId: outsider.id, request: { ref } }))
                .rejects.toMatchObject({ code: "collection_unavailable" });
        });
    });

    it("keeps the active Account quota gate and rolls back an inadmissible declaration", async () => {
        const { account, manifest, ref, headers } = await fixture();
        await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
            const first = await app.inject({ method: "POST", url: route, headers, payload: { manifest } });
            expect(first.statusCode, first.body).toBe(200);
            const mutated = await mutatePluginCollection({ accountId: account.id, authentication: createPresentUserSessionAccessAuthentication(), request: {
                pluginId: manifest.id, collectionId: ref.collectionId,
                writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                operations: ["one", "two"].map(rowId => ({ kind: "put", rowId, expectedRevision: "absent", expectedAbsenceEpoch: 0,
                    content: { t: "plain", v: {} }, projection: { status: "open" } })),
            } });
            expect(mutated.status).toBe("updated");
            const before = await db.account.findUniqueOrThrow({ where: { id: account.id } });
            const keys = ["HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS", "HAPPIER_COLLECTION_MAX_BATCH_ROWS"] as const;
            const previous = keys.map(key => process.env[key]);
            try {
                for (const key of keys) process.env[key] = "1";
                const refused = await app.inject({ method: "POST", url: route, headers,
                    payload: { manifest: { ...manifest, version: "2.0.0", contributes: { accountCollections: [
                        ...manifest.contributes.accountCollections,
                        { ...manifest.contributes.accountCollections[0]!, id: "new-items" },
                    ] } } } });
                expect(refused.statusCode, refused.body).toBe(409);
                expect(refused.json()).toEqual({ error: "collection_quota_incompatible", dimension: "maxRows", effectiveMaximum: 1 });
            } finally {
                keys.forEach((key, index) => {
                    if (previous[index] === undefined) delete process.env[key];
                    else process.env[key] = previous[index];
                });
            }
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(before.seq);
            // Contract preparation moved before Account locking, but its writes
            // still belong to the rejected claim's transaction.
            expect(await db.pluginCollectionContract.count({ where: { pluginId: manifest.id } })).toBe(1);
            expect(await db.pluginCollectionRow.count({ where: { accountId: account.id, deletedAt: null } })).toBe(2);
            const current = await inTx(tx => resolveCurrentPluginDeclarationsTx({ tx, accountId: account.id,
                refs: [{ pluginId: manifest.id, version: manifest.version }, { pluginId: manifest.id, version: "2.0.0" }] }));
            expect([...current.values()].map(value => value.manifest.version)).toEqual([manifest.version]);
        });
    });

    it.each(["same", "different"] as const)("materializes one shared immutable contract when %s Accounts first claim the same external plugin", async accountScope => {
        const { account, manifest, ref, headers } = await fixture(false);
        const peerAccount = accountScope === "same" ? account
            : await db.account.create({ data: { publicKey: null, encryptionMode: "plain" } });
        if (accountScope === "different") accountIds.push(peerAccount.id);
        const pending: Promise<unknown>[] = [];
        let observed = false;
        try {
            await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
                const first = await observeTransactions(tx => {
                    const find = tx.pluginCollectionContract.findFirst.bind(tx.pluginCollectionContract);
                    tx.pluginCollectionContract.findFirst = (async (args: Parameters<typeof find>[0]) => {
                        const current = await find(args);
                        if (!observed && current === null) {
                            observed = true;
                            await commitOrBlock(tx, async () => {
                                const peer = await app.inject({ method: "POST", url: route,
                                    headers: { "x-test-user-id": peerAccount.id }, payload: { manifest } });
                                expect(peer.statusCode, peer.body).toBe(200);
                            }, pending);
                        }
                        return current;
                    }) as unknown as typeof tx.pluginCollectionContract.findFirst;
                }, () => app.inject({ method: "POST", url: route, headers, payload: { manifest } }));
                expect(first.statusCode, first.body).toBe(200);
                PluginAvailabilityCollectionWritersClaimActionOutputV1Schema.parse(first.json());
                await Promise.all(pending);
                expect(await db.pluginCollectionContract.count({ where: { pluginId: manifest.id } })).toBe(1);
                for (const accountId of [account.id, peerAccount.id]) {
                    await expect(readCurrentPluginCollectionContract({ accountId, request: { ref } }))
                        .resolves.toMatchObject({ access: "writable" });
                }
            });
        } finally { await Promise.allSettled(pending); }
        expect(observed).toBe(true);
    });
});
