import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { listArtifactHeadersForCallerInTx } from './artifactAccessService';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Artifact inventory PostgreSQL query work', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it('keeps a populated page near batched relation work when PostgreSQL compiles the access query', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const bytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
        const artifactData = (accountId: string) => ({ id: randomUUID(), accountId,
            header: bytes({ title: 'Inventory document' }), body: bytes({ body: 'Retained content' }),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            headerVersion: 1, bodyVersion: 1, seq: 1 });
        await db.artifact.createMany({ data: Array.from({ length: 2500 }, () => artifactData(owner.id)) });
        const shared = await db.artifact.create({ data: artifactData(other.id) });
        await db.artifactAccountGrant.create({ data: { artifactId: shared.id, accountId: owner.id,
            accessLevel: 'view', createdByAccountId: other.id } });

        type Variant = 'owner' | 'batched-control';
        let variant: Variant = 'owner';
        const durations: Record<Variant, number[]> = { owner: [], 'batched-control': [] };
        const measured = db.$extends({ query: { artifact: { async findMany({ args, query }) {
            const page = args.take !== undefined;
            const started = performance.now();
            const rows = await query({ ...args, ...(page && variant === 'batched-control'
                ? { relationLoadStrategy: 'query' as const } : {}) });
            if (page) durations[variant].push(performance.now() - started);
            return rows;
        } } } });
        // Preserve the generated client's contract while forwarding real queries,
        // as the canonical shared-QA diagnostics adapter does in storage/prisma.
        const client = new Proxy(db, {
            get(_target, property) {
                const value = Reflect.get(measured, property, measured);
                return typeof value === 'function' ? value.bind(measured) : value;
            },
        });
        const snapshots = [];
        for (const selected of ['owner', 'batched-control', 'batched-control', 'owner', 'owner', 'batched-control'] as const) {
            variant = selected;
            snapshots.push(await client.$transaction(async tx => {
                // The observed production plan crossed all three JIT thresholds
                // (129 functions; 914 ms compilation / 948 ms execution). Force
                // that same engine path without needing production cardinalities.
                await tx.$executeRawUnsafe('SET LOCAL jit_above_cost = 0');
                await tx.$executeRawUnsafe('SET LOCAL jit_inline_above_cost = 0');
                await tx.$executeRawUnsafe('SET LOCAL jit_optimize_above_cost = 0');
                return await listArtifactHeadersForCallerInTx(tx, { actorAccountId: owner.id, limit: 500, cursor: null });
            }, { isolationLevel: 'RepeatableRead' }));
        }
        expect(snapshots[0]).toHaveLength(500);
        expect(snapshots[0].find(row => row.id === shared.id)?.access).toBe('view');
        for (const snapshot of snapshots.slice(1)) expect(snapshot).toEqual(snapshots[0]);
        const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
        expect(durations.owner).toHaveLength(3);
        expect(durations['batched-control']).toHaveLength(3);
        // Relative regression guard against the same database and projection,
        // not a new product deadline. The reproduced owner exceeded this margin.
        expect(median(durations.owner), JSON.stringify(durations))
            .toBeLessThan(median(durations['batched-control']) * 2);
    });
});
