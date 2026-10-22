import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { readPluginsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { PluginAccountCollectionContributionV1Schema } from "@happier-dev/protocol/plugins/data/collectionsV1";
import { materializePluginCollectionContractsTx } from "./contracts";
import { measurePluginCollectionStoredRowEncodedBytes, readPluginCollectionAccountActivationUsageInTx,
    readPluginCollectionAccountUsageInTx } from "./quota";

/** Observe returned database policy materializations without replacing any database operation. */
function observePolicyTransfer(real: Tx) {
    const policies = new Map<string, number>();
    const policyReads: unknown[] = [];
    function observe(value: unknown) {
        if (!Array.isArray(value)) return;
        for (const row of value) {
            if (!row || typeof row !== "object") continue;
            const policy = "contract" in row ? row.contract : row;
            if (policy && typeof policy === "object" && "id" in policy && typeof policy.id === "string"
                && "normalizedSchema" in policy && "privacyProjection" in policy) {
                policies.set(policy.id, (policies.get(policy.id) ?? 0) + 1);
            }
        }
    }
    // Narrow boundary fixture: a call-through delegate proxy observes actual PG results.
    const tx = new Proxy(real, {
        get(target, name) {
            const delegate = Reflect.get(target, name);
            if (name !== "pluginCollectionRow" && name !== "pluginCollectionContract") return delegate;
            return new Proxy(delegate, {
                get(model, operation) {
                    const fn: unknown = Reflect.get(model, operation);
                    if (typeof fn !== "function") return fn;
                    return async (...args: unknown[]) => {
                        if (name === "pluginCollectionContract" && operation === "findMany") policyReads.push(args);
                        const result: unknown = await Reflect.apply(fn, model, args);
                        observe(result);
                        return result;
                    };
                },
            });
        },
    });
    return { tx, policies, policyReads };
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Collection quota census policy transfer", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it("materializes each immutable policy once across pages without changing either quota census", async () => {
        const pluginId = `example.quota.${randomUUID()}`;
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const other = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        await inTx(tx => materializePluginCollectionContractsTx({ tx, pluginId,
            contributions: ["tasks", "notes", "retired", "foreign"].map(id => PluginAccountCollectionContributionV1Schema.parse({ id, schemaVersion: 1,
                rowIdField: "text",
                schema: { type: "object", properties: { text: { type: "string", maxLength: 256 } },
                    required: ["text"], additionalProperties: false },
                serverReadable: ["text"], indexes: [],
            })),
        }));
        const contracts = await db.pluginCollectionContract.findMany({ where: { pluginId }, orderBy: { collectionId: "asc" } });
        const liveContracts = contracts.filter(row => row.collectionId === "tasks" || row.collectionId === "notes");
        const retiredContract = contracts.find(row => row.collectionId === "retired")!;
        const foreignContract = contracts.find(row => row.collectionId === "foreign")!;
        const envelope = { t: "plain", v: { text: "retained" } };
        const liveRows = 1005;
        try {
            await inTx(async real => {
                for (const read of [readPluginCollectionAccountUsageInTx, readPluginCollectionAccountActivationUsageInTx]) {
                    const measured = observePolicyTransfer(real);
                    const usage = await read({ tx: measured.tx, accountId: account.id,
                        deployment: readPluginsFeatureEnv(process.env).collectionLimits });
                    expect(usage.rows).toBe(0);
                    expect(usage.encodedBytes).toBe(0);
                    expect(usage.contracts.size).toBe(0);
                    expect(measured.policyReads).toHaveLength(0);
                }
            });
            const makeRow = (index: number, accountId = account.id, deletedAt: Date | null = null,
                contract = liveContracts[index % liveContracts.length]) => {
                return { accountId, pluginId, collectionId: contract.collectionId, rowId: `row-${index}`,
                    schemaVersion: 1, revision: 1, contractId: contract.id, contractDigest: contract.contractDigest,
                    contentEnvelope: envelope, deletedAt };
            };
            await db.pluginCollectionRow.createMany({ data: [
                ...Array.from({ length: liveRows }, (_, index) => makeRow(index)),
                makeRow(liveRows, account.id, new Date(), retiredContract),
                makeRow(liveRows + 1, other.id, null, foreignContract),
            ] });
            const expectedBytes = Array.from({ length: liveRows }, (_, index) =>
                measurePluginCollectionStoredRowEncodedBytes({ rowId: `row-${index}`, contentEnvelope: envelope, projections: [] }))
                .reduce((sum, bytes) => sum + bytes, 0);
            await inTx(async real => {
                for (const read of [readPluginCollectionAccountUsageInTx, readPluginCollectionAccountActivationUsageInTx]) {
                    const measured = observePolicyTransfer(real);
                    // One initial ceiling-sized page and at least two measured-row pages.
                    const usage = await read({ tx: measured.tx, accountId: account.id,
                        deployment: { ...readPluginsFeatureEnv(process.env).collectionLimits, maxRowEncodedBytes: 16 * 1024 * 1024 } });
                    expect(usage.rows).toBe(liveRows);
                    expect(usage.encodedBytes).toBe(expectedBytes);
                    expect([...usage.collections.values()].map(row => row.rows).sort()).toEqual([502, 503]);
                    expect([...usage.contracts.keys()].sort()).toEqual(liveContracts.map(row => row.id).sort());
                    expect([...measured.policies.entries()].sort()).toEqual(liveContracts.map(row => [row.id, 1]).sort());
                    // Policy I/O must not interrupt the live-row walk as new
                    // contract identities appear on later pages.
                    expect(measured.policyReads).toHaveLength(1);
                }
            }, { isolationLevel: "ReadCommitted" });
        } finally {
            await db.account.deleteMany({ where: { id: { in: [account.id, other.id] } } });
            await db.pluginCollectionContract.deleteMany({ where: { id: { in: contracts.map(row => row.id) } } });
        }
    });
});
