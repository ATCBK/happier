import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";
import { randomUUID } from "node:crypto";

import {
    db,
    initDbMysql,
    initDbPostgres,
} from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "./accountSessionOwnerMetadataFence";
import { markAccountChanged } from "@/app/changes/markAccountChanged";

function resolveContractProviderFromEnv(): "postgres" | "mysql" {
    const raw = (
        process.env.HAPPIER_DB_PROVIDER
        ?? process.env.HAPPY_DB_PROVIDER
        ?? "postgres"
    ).toString().trim().toLowerCase();
    if (raw === "postgresql" || raw === "postgres") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(
        `Unsupported contract provider: ${raw}. Set HAPPIER_DB_PROVIDER=postgres|mysql (or HAPPY_DB_PROVIDER=postgres|mysql)`,
    );
}

function deferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const provider = resolveContractProviderFromEnv();
const publicKeyPrefix = "dbcontract-account-session-owner-fence-";

describe("Account Session owner-metadata fence database contract", () => {
    let dbConnected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error(
                "Missing DATABASE_URL (required for db contract tests).",
            );
        }
        if (provider === "mysql") {
            await initDbMysql();
        } else {
            initDbPostgres();
        }
        await db.$connect();
        dbConnected = true;
    });

    afterEach(async () => {
        await db.account.deleteMany({
            where: { publicKey: { startsWith: publicKeyPrefix } },
        });
    });

    afterAll(async () => {
        if (dbConnected) {
            await db.$disconnect();
        }
    });

    it(`serializes concurrent Account fences on ${provider}`, async () => {
        const initialUpdatedAt = new Date("2020-01-02T03:04:05.000Z");
        const account = await db.account.create({
            data: {
                publicKey: `${publicKeyPrefix}${randomUUID()}`,
                settingsVersion: 7,
                updatedAt: initialUpdatedAt,
            },
            select: { id: true },
        });
        const firstAcquired = deferred();
        const releaseFirst = deferred();
        let secondAcquired = false;

        const first = inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id);
            firstAcquired.resolve();
            await releaseFirst.promise;
        });
        await firstAcquired.promise;

        const second = inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id);
            secondAcquired = true;
        });

        try {
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(secondAcquired).toBe(false);
        } finally {
            releaseFirst.resolve();
        }

        await first;
        await second;
        await expect(db.account.findUnique({
            where: { id: account.id },
            select: {
                settingsVersion: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            settingsVersion: 7,
            updatedAt: initialUpdatedAt,
        });
    });

    it.skipIf(provider !== "postgres")("rejects a shared stability fence followed by concurrent cursor allocation", async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const bothShared = deferred();
        let acquired = 0;
        const publish = (entityId: string) => db.$transaction(async tx => {
            // Experimental alternative, deliberately outside the production owner:
            // both writers can enter, but both subsequently need Account.seq.
            await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR SHARE', account.id);
            if (++acquired === 2) bothShared.resolve();
            await bothShared.promise;
            return markAccountChanged(tx, { accountId: account.id, kind: "account", entityId });
        });
        const outcomes = await Promise.allSettled([publish("shared-first"), publish("shared-second")]);
        const rejected = outcomes.filter(outcome => outcome.status === "rejected");
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toMatchObject({ meta: { code: "40P01" } });
        expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
            .toEqual({ seq: 1 });
        expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(1);
    });

    it.skipIf(provider !== "postgres")("does not mistake a key-share lock for non-key Account mode stability", async () => {
        const account = await db.account.create({ data: {
            publicKey: `${publicKeyPrefix}${randomUUID()}`, encryptionMode: "e2ee",
        } });
        const locked = deferred();
        const release = deferred();
        const holder = db.$transaction(async tx => {
            await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR KEY SHARE', account.id);
            locked.resolve();
            await release.promise;
        });
        const holderOutcome = Promise.allSettled([holder]);
        try {
            await Promise.race([locked.promise, holder.then(() => { throw new Error("Key-share holder ended before acquisition"); })]);
            // Fail immediately if blocked; this is a lock-conflict probe, not a
            // production deadline. The real transition updates these non-key columns.
            await expect(db.$transaction(async tx => {
                await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', account.id);
                await tx.account.update({ where: { id: account.id }, data: { encryptionMode: "plain" } });
            })).resolves.toBeUndefined();
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { encryptionMode: true } }))
                .toEqual({ encryptionMode: "plain" });
            await expect(db.$transaction(tx => tx.$queryRawUnsafe(
                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE NOWAIT', account.id,
            ))).rejects.toMatchObject({ meta: { code: "55P03" } });
        } finally {
            release.resolve();
            for (const outcome of await holderOutcome) if (outcome.status === "rejected") throw outcome.reason;
        }
    });

    it.skipIf(provider !== "postgres")("cannot acquire the existing exclusive metadata owner after concurrent key-share entry", async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const bothShared = deferred();
        let acquired = 0;
        const write = () => db.$transaction(async tx => {
            await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR KEY SHARE', account.id);
            if (++acquired === 2) bothShared.resolve();
            await bothShared.promise;
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id);
        });
        const outcomes = await Promise.allSettled([write(), write()]);
        const rejected = outcomes.filter(outcome => outcome.status === "rejected");
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toMatchObject({ meta: { code: "40P01" } });
    });
});
