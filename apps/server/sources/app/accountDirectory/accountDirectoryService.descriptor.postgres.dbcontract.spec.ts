import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import { createHomeCredentialDestinationDigestV1, encodeBase64 } from "@happier-dev/protocol";

const fileBoundary = vi.hoisted(() => ({ observe: null as null | (() => Promise<void>) }));
vi.mock("node:fs/promises", async importOriginal => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
        ...actual,
        readFile: async (...args: Parameters<typeof actual.readFile>) => {
            if (String(args[0]).endsWith("home.descriptor.json")) await fileBoundary.observe?.();
            return actual.readFile(...args);
        },
        writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
            if (String(args[0]).includes("home.descriptor.json")) await fileBoundary.observe?.();
            return actual.writeFile(...args);
        },
    };
});

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { inTx } from "@/storage/inTx";
import { createHomeApprovalGate } from "@/app/api/routes/auth/homeApprovalGate";
import { mintHomeLoginAssertion, accountDirectorySigningKeyMetadata, resolveAccountDirectorySigningKeyPair } from "./accountDirectorySigner";
import { redeemHomeLoginAssertion } from "./accountDirectoryService";
import { resetHomeConnectionDescriptorRevisionOwnerForTests } from "@/app/features/homeConnectionDescriptorPublication";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Home login descriptor preparation (PostgreSQL)", () => {
    let originalDatabaseUrl: string | undefined;
    const applicationName = `ovbfix-descriptor-${randomUUID()}`;
    beforeAll(async () => {
        const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error("Use the disposable PostgreSQL harness");
        originalDatabaseUrl = supplied;
        const url = new URL(supplied);
        url.searchParams.set("application_name", applicationName);
        process.env.DATABASE_URL = url.toString();
        vi.stubEnv("HANDY_MASTER_SECRET", "ovbfix-fixture-only");
        initDbPostgres();
        await db.$connect();
        await auth.init();
    });
    afterAll(async () => {
        fileBoundary.observe = null;
        await db.$disconnect();
        if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl;
        vi.unstubAllEnvs();
    });

    it.each([false, true])("prepares outside the token transaction and validates the live destination (changed during admission: %s)", async changeDuringAdmission => {
        const dataDir = await mkdtemp(join(tmpdir(), "ovbfix-descriptor-"));
        const env = { HAPPIER_DB_PROVIDER: "postgres", HAPPIER_STACK_SHARED_DB_SOURCE_STACK: "fixture-only",
            HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir, HAPPIER_SERVER_IDENTITY_ID: "srv_ovbfix_home",
            HAPPIER_CANONICAL_SERVER_URL: "https://ovbfix-home.test", HAPPIER_PUBLIC_SERVER_URL: "https://ovbfix-home.test",
            HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: "0", HANDY_MASTER_SECRET: "ovbfix-fixture-only" };
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const metadata = accountDirectorySigningKeyMetadata(env);
        await db.accountDirectoryLink.create({ data: { accountId: account.id, issuerServerIdentityId: env.HAPPIER_SERVER_IDENTITY_ID,
            issuerSubjectId: account.id, issuerSigningKeyId: metadata.keyId,
            issuerSigningPublicKey: new Uint8Array(resolveAccountDirectorySigningKeyPair(env).publicKey) } });
        const client = tweetnacl.box.keyPair();
        const assertion = await mintHomeLoginAssertion({ issuerSubjectId: account.id, audienceHomeServerIdentityId: env.HAPPIER_SERVER_IDENTITY_ID,
            clientBoxPublicKeyBase64: encodeBase64(client.publicKey, "base64"), env,
            credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1({ v: 1,
                homeServerIdentityId: env.HAPPIER_SERVER_IDENTITY_ID, canonicalServerUrl: env.HAPPIER_CANONICAL_SERVER_URL,
                revision: 1, endpoints: [{ kind: "https", url: env.HAPPIER_PUBLIC_SERVER_URL }] }) });
        const fileWorkInTransaction: number[] = [];
        let fileWork = 0;
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        let ready!: (pid: number) => void;
        const started = new Promise<number>(resolve => { ready = resolve; });
        let writer: Promise<void> | undefined;
        resetHomeConnectionDescriptorRevisionOwnerForTests();
        fileBoundary.observe = async () => {
            fileWork += 1;
            const [{ count }] = await db.$queryRaw<Array<{ count: number }>>`
                SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()
                AND application_name = ${applicationName} AND state = 'idle in transaction'
            `;
            if (count) fileWorkInTransaction.push(count);
            if (changeDuringAdmission && !writer) {
                writer = inTx(async tx => {
                    await tx.$executeRaw`LOCK TABLE "AccountDirectoryLink" IN ACCESS EXCLUSIVE MODE`;
                    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                    ready(pid);
                    await released;
                }, { isolationLevel: "Serializable" });
                await Promise.race([started, writer]);
            }
        };
        let redemption: ReturnType<typeof redeemHomeLoginAssertion> | undefined;
        try {
            let issued = false;
            redemption = redeemHomeLoginAssertion({ assertion, env, homeApprovalGate: createHomeApprovalGate(env),
                issueHomeToken: async (tx, accountId) => {
                    issued = true;
                    return auth.createTokenInTx(tx, accountId, undefined, { kind: "account", authority: "present_user" });
                } });
            const outcome = Promise.allSettled([redemption]);
            if (changeDuringAdmission) {
                const writerPid = await started;
                let settled = false;
                void outcome.then(() => { settled = true; });
                let blocked = false;
                while (!settled) {
                    const rows = await db.$queryRaw<Array<{ pid: number }>>`
                        SELECT pid FROM pg_stat_activity WHERE datname = current_database()
                        AND application_name = ${applicationName} AND ${writerPid} = ANY(pg_blocking_pids(pid))
                    `;
                    if (rows.length) { blocked = true; break; }
                }
                expect(blocked).toBe(true);
                env.HAPPIER_PUBLIC_SERVER_URL = "https://replacement.test";
                release();
                await writer;
                await expect(redemption).rejects.toMatchObject({ code: "credential_destination_mismatch" });
                expect(issued).toBe(false);
            } else {
                expect(await redemption).toMatchObject({ v: 1, homeServerIdentityId: env.HAPPIER_SERVER_IDENTITY_ID });
                expect(issued).toBe(true);
                expect(fileWorkInTransaction).toEqual([]);
            }
            await outcome;
            expect(fileWork).toBeGreaterThan(0);
        } finally {
            release();
            if (writer) await Promise.allSettled([writer]);
            if (redemption) await Promise.allSettled([redemption]);
            fileBoundary.observe = null;
            resetHomeConnectionDescriptorRevisionOwnerForTests();
            await db.account.delete({ where: { id: account.id } });
            await rm(dataDir, { recursive: true, force: true });
        }
    });
});
