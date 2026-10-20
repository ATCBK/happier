import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { initEncrypt } from "@/modules/encrypt";
import { inTx } from "@/storage/inTx";
import {
    listQualifiedConnectedAccounts,
    mutateQualifiedConnectedServiceCredential,
    mutateQualifiedConnectedServiceCredentialInTx,
} from "./credentialRepository";

const service = { pluginId: "example.connected-accounts", localId: "list-contract" };

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Connected Account list statement snapshot", () => {
    let connected = false;
    let previousMasterSecret: string | undefined;

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        previousMasterSecret = process.env.HANDY_MASTER_SECRET;
        process.env.HANDY_MASTER_SECRET ??= "connected-account-list-contract";
        await initEncrypt();
        initDbPostgres();
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (connected) await db.$disconnect();
        if (previousMasterSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
        else process.env.HANDY_MASTER_SECRET = previousMasterSecret;
    });

    it("lists a coherent committed credential set during a concurrent update without retaining predicate locks", async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const inputs = ["first", "second"].map(accountId => ({
            accountId: account.id,
            ref: { service, accountId },
            authenticationModeId: "api-key",
            content: { t: "plain" as const, v: { token: "fixture" } },
            metadata: { displayName: `before-${accountId}`, scopes: ["account.read"] },
        }));
        let releaseWriter!: () => void;
        const writerRelease = new Promise<void>(resolve => { releaseWriter = resolve; });
        let writerReady!: (pid: number) => void;
        const ready = new Promise<number>(resolve => { writerReady = resolve; });
        let writer: Promise<string[]> | undefined;
        try {
            const initialRevisions: string[] = [];
            for (const input of inputs) {
                const created = await mutateQualifiedConnectedServiceCredential({ ...input, expectedCredentialRevision: null });
                if (created.status !== "written") throw new Error("Expected fixture credential");
                initialRevisions.push(created.credentialRevision);
            }
            writer = inTx(async tx => {
                const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                const revisions: string[] = [];
                for (const [index, input] of inputs.entries()) {
                    const updated = await mutateQualifiedConnectedServiceCredentialInTx(tx, {
                        ...input,
                        expectedCredentialRevision: initialRevisions[index],
                        expectedConfigurationRevision: null,
                        metadata: { ...input.metadata, displayName: `after-${input.ref.accountId}` },
                    });
                    if (updated.status !== "written") throw new Error("Expected concurrent credential update");
                    revisions.push(updated.credentialRevision);
                }
                writerReady(pid);
                await writerRelease;
                return revisions;
            }, { isolationLevel: "Serializable" });
            const writerPid = await Promise.race([ready, writer.then(() => { throw new Error("Writer exited before rendezvous"); })]);
            const project = (profiles: Awaited<ReturnType<typeof listQualifiedConnectedAccounts>>) => profiles.map(profile => ({
                accountId: profile.ref.accountId, displayName: profile.displayName, credentialRevision: profile.credentialRevision,
            }));
            const before = inputs.map((input, index) => ({
                accountId: input.ref.accountId, displayName: input.metadata.displayName, credentialRevision: initialRevisions[index],
            }));
            const concurrentLists = await Promise.all([0, 1].map(() => listQualifiedConnectedAccounts({ accountId: account.id, service })));
            for (const profiles of concurrentLists) expect(project(profiles)).toEqual(before);
            const [{ count }] = await db.$queryRaw<Array<{ count: number }>>`
                SELECT count(*)::int AS count FROM pg_locks
                WHERE mode = 'SIReadLock' AND pid IS DISTINCT FROM ${writerPid}
                AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            `;
            // The active Serializable writer keeps committed readers' SSI locks
            // alive. A single-statement list needs no such cross-statement fence.
            expect(count).toBe(0);
            releaseWriter();
            const updatedRevisions = await writer;
            expect(project(await listQualifiedConnectedAccounts({ accountId: account.id, service }))).toEqual(
                inputs.map((input, index) => ({ accountId: input.ref.accountId,
                    displayName: `after-${input.ref.accountId}`, credentialRevision: updatedRevisions[index] })),
            );
        } finally {
            releaseWriter();
            try { await writer; }
            finally { await db.account.delete({ where: { id: account.id } }); }
        }
    });
});
