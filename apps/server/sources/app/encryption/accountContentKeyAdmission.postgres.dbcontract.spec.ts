import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "./accountSessionOwnerMetadataFence";
import { admitAccountContentKey } from "./accountContentKeyAdmission";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Content key admission contention", () => {
    beforeAll(async () => {
        if (!process.env.DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each(["complete", "missing_key", "missing_signature"] as const)("only excludes content writers when the binding changes (%s)", async state => {
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({ data: { ...binding, encryptionMode: "plain",
            ...(state === "missing_key" ? { contentPublicKey: null, contentPublicKeySig: null }
                : state === "missing_signature" ? { contentPublicKeySig: null } : {}),
        } });
        let pending: Promise<Awaited<ReturnType<typeof admitAccountContentKey>>> | undefined;
        let result: Awaited<ReturnType<typeof admitAccountContentKey>> | undefined;
        let settled = false;
        try {
            await inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "content");
                const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                pending = inTx(client => admitAccountContentKey(client, { accountId: account.id,
                    contentPublicKey: binding.contentPublicKey, contentPublicKeySignature: binding.contentPublicKeySig,
                })).then(value => { result = value; return value; }).finally(() => { settled = true; });
                void pending.catch(() => undefined);
                while (!settled) {
                    const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                            WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
                    `;
                    if (blocked) break;
                }
                expect(result !== undefined, "Only binding initialization/repair needs exclusive admission").toBe(state === "complete");
            });
        } finally {
            try {
                if (pending) expect(await pending).toMatchObject({ status: state === "complete" ? "unchanged"
                    : state === "missing_key" ? "initialized" : "signature_filled" });
                const stored = await db.account.findUniqueOrThrow({ where: { id: account.id } });
                expect(new Uint8Array(stored.contentPublicKey!)).toEqual(binding.contentPublicKey);
                expect(new Uint8Array(stored.contentPublicKeySig!)).toEqual(binding.contentPublicKeySig);
                expect(stored.seq).toBe(account.seq);
            } finally { await db.account.delete({ where: { id: account.id } }); }
        }
    });
});
