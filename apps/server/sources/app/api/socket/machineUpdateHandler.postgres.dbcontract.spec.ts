import { randomUUID } from "node:crypto";

import type { Socket } from "socket.io";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
    MACHINE_PLAIN_DATA_KEY_MARKER,
    MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
    MachineUpdateOperationProtocolCapabilitiesResponseV1Schema,
    MachineUpdateStateResponseSchema,
    encodePlainMachineStoredContent,
} from "@happier-dev/protocol";
import { auth } from "@/app/auth/auth";
import {
    evaluateAccountStoredContentSocketCompatibility,
    writeAccountStoredContentCompatibilityForSocket,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import * as privacyKit from "privacy-kit";

import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";
import { machineUpdateHandler } from "./machineUpdateHandler";
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from "./machineSocketInstallationProof";
import { withAuthenticatedTestApp } from "../testkit/sqliteFastify";
import { currentAccountStoredContentCompatibilityHeaders } from "../testkit/accountStoredContentCompatibility";
import { machinesRoutes } from "../routes/machines/machinesRoutes";
import { MachinePublishedRowV1Schema } from "@happier-dev/protocol/machines/machineContentKeyTransitionV1";

const HANDLER_OPTIONS = {
    operationSocketBatchLimits: {
        ok: true as const,
        limits: { maxItems: 200, maxSerializedBytes: 524_288 },
    },
};

const PUBLISHED_METADATA = {
    host: "publication-host",
    platform: "linux",
    happyCliVersion: "0.3.0",
    homeDir: "/home/publication",
    happyHomeDir: "/home/publication/.happier",
};

async function createMachineFixture() {
    const account = await db.account.create({ data: { encryptionMode: "plain" } });
    const installationId = randomUUID();
    const machine = await db.machine.create({
        data: {
            id: randomUUID(),
            accountId: account.id,
            metadata: encodePlainMachineStoredContent(PUBLISHED_METADATA),
            daemonState: encodePlainMachineStoredContent({ status: "offline" }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId,
        },
    });
    const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
    const socket = Object.assign(createFakeSocket({ data: {
        clientType: "machine-scoped",
        machineId: machine.id,
        [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: installationId,
    } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
    writeAccountStoredContentCompatibilityForSocket(
        socket as unknown as Socket,
        evaluateAccountStoredContentSocketCompatibility({
            accountStoredContentCompatibility: { v: 1, protocolVersion: 4 },
        }),
    );
    machineUpdateHandler(account.id, socket as unknown as Socket, HANDLER_OPTIONS);
    return { accountId: account.id, machineId: machine.id, socket };
}

/**
 * Advance a genuine same-Account publisher at the last point before the Machine
 * writer fences publication. Older writers have no fence, so the peer advances
 * immediately before their Machine CAS and creates the PostgreSQL SSI pivot.
 */
function beforeMachinePublicationLock(machineId: string, accountId: string) {
    const transaction = db.$transaction;
    let advanced = false;
    db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [async (tx: Tx) => {
            let addressed = false;
            const advancePeer = async () => {
                if (advanced) return;
                advanced = true;
                await inTx(async (peerTx) => {
                    await markAccountChanged(peerTx, { accountId, kind: "account", entityId: accountId });
                }, { isolationLevel: "ReadCommitted", transactionClass: "machine-publication-test-peer" });
            };
            return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property === "$queryRawUnsafe") return async (query: string, ...values: unknown[]) => {
                    if (addressed && query.includes('FROM "Account"') && query.includes("FOR ")) await advancePeer();
                    return inner.$queryRawUnsafe(query, ...values);
                };
                if (property !== "machine") return Reflect.get(inner, property, innerReceiver);
                return new Proxy(inner.machine, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method === "findFirst") return (...queryArgs: Parameters<typeof tx.machine.findFirst>) => {
                        if (queryArgs[0]?.where?.id === machineId) addressed = true;
                        return Reflect.apply(operation, delegate, queryArgs);
                    };
                    if (method === "findUnique") return (...queryArgs: Parameters<typeof tx.machine.findUnique>) => {
                        if (queryArgs[0]?.where?.id === machineId) addressed = true;
                        return Reflect.apply(operation, delegate, queryArgs);
                    };
                    if (method !== "updateMany") return operation;
                    return async (...queryArgs: Parameters<typeof tx.machine.updateMany>) => {
                        if (queryArgs[0]?.where?.id === machineId) await advancePeer();
                        return Reflect.apply(operation, delegate, queryArgs);
                    };
                } });
            } }));
        }, ...args.slice(1)]);
    } });
    return () => {
        db.$transaction = transaction;
        return advanced;
    };
}

async function publishUnderContention(event: string, payload: unknown) {
    const fixture = await createMachineFixture();
    const restore = beforeMachinePublicationLock(fixture.machineId, fixture.accountId);
    const callback = vi.fn();
    let advanced = false;
    try {
        await getSocketHandler(fixture.socket, event)(payload instanceof Function ? payload(fixture) : payload, callback);
    } finally {
        advanced = restore();
    }
    return { ...fixture, callback, advanced };
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")(
    "Machine writes under PostgreSQL publication contention",
    () => {
        let connected = false;
        beforeAll(async () => {
            if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
                || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
                throw new Error("Run with the disposable PostgreSQL DB-contract harness");
            }
            vi.stubEnv("HANDY_MASTER_SECRET", "machine-publication-postgres-secret");
            vi.stubEnv("AUTH_REQUIRED_LOGIN_PROVIDERS", "");
            vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
            initDbPostgres();
            await db.$connect();
            await auth.init();
            connected = true;
        });
        afterAll(async () => {
            if (connected) await db.$disconnect();
            vi.unstubAllEnvs();
        });

        it("commits operation capabilities while another writer publishes the Account", async () => {
            const fixture = await publishUnderContention(
                MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
                (current: Awaited<ReturnType<typeof createMachineFixture>>) => ({
                    machineId: current.machineId,
                    capabilities: { sessionSpawn: { protocolVersions: [1] } },
                }),
            );
            expect(fixture.callback).toHaveBeenCalledWith({ v: 1, result: "success", revision: 1 });
            expect(fixture.advanced).toBe(true);
            expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } }))
                .toMatchObject({ operationProtocolCapabilitiesRevision: 1 });
        });

        it.each(["equal", "changed"] as const)("a %s capabilities refresh joins Account publication only when it changes storage", async kind => {
            const fixture = await createMachineFixture();
            const capabilities = { sessionSpawn: { protocolVersions: [1] } };
            const handler = getSocketHandler(fixture.socket, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1);
            const initial = vi.fn();
            await handler({ machineId: fixture.machineId, capabilities }, initial);
            expect(initial).toHaveBeenCalledWith({ v: 1, result: "success", revision: 1 });
            const before = await db.account.findUniqueOrThrow({ where: { id: fixture.accountId }, select: { seq: true } });
            const callback = vi.fn();
            const nextCapabilities = kind === "equal" ? capabilities : { sessionSpawn: { protocolVersions: [1, 2] } };
            let pending: Promise<unknown> | undefined;
            let blocked = false;
            let waits: Array<{ wait_event_type: string | null; wait_event: string | null; account_statement: boolean }> = [];
            await db.$transaction(async peer => {
                const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                await peer.account.update({ where: { id: fixture.accountId }, data: { seq: { increment: 1 } } });
                let settled = false;
                pending = Promise.resolve(handler({ machineId: fixture.machineId, capabilities: nextCapabilities }, callback))
                    .finally(() => { settled = true; });
                void pending.catch(() => undefined);
                while (!settled) {
                    const [state] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                            WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
                    `;
                    if (state.blocked) {
                        blocked = true;
                        waits = await db.$queryRaw`SELECT wait_event_type, wait_event, query LIKE '%Account%' AS account_statement
                            FROM pg_stat_activity WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))`;
                        break;
                    }
                }
            });
            await pending;
            console.info("FIX99 Machine publication wait", { kind, blocked, waits });
            if (kind === "changed") {
                console.info("FIX99 Account publication plan", JSON.stringify(await db.$queryRawUnsafe(
                    'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT "id" FROM "Account" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR NO KEY UPDATE',
                    [fixture.accountId],
                )));
            }
            expect(blocked, "Only a changed projection needs the Account publication row").toBe(kind === "changed");
            expect(MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse(callback.mock.calls[0]?.[0]))
                .toEqual({ v: 1, result: "success", revision: kind === "equal" ? 1 : 2 });
            expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } }))
                .toMatchObject({ operationProtocolCapabilities: nextCapabilities,
                    operationProtocolCapabilitiesRevision: kind === "equal" ? 1 : 2 });
            expect(await db.account.findUniqueOrThrow({ where: { id: fixture.accountId }, select: { seq: true } }))
                .toEqual({ seq: before.seq + (kind === "equal" ? 1 : 2) });
            await db.machine.update({ where: { id: fixture.machineId }, data: { revokedAt: new Date() } });
            const revoked = vi.fn();
            await handler({ machineId: fixture.machineId, capabilities: nextCapabilities }, revoked);
            expect(MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse(revoked.mock.calls[0]?.[0]))
                .toEqual({ v: 1, result: "error", code: "machine_unavailable" });
        });

        it.each(["revoked", "reinstalled"] as const)("readmits an equal capabilities refresh after its Machine is %s", async kind => {
            const fixture = await createMachineFixture();
            const capabilities = { sessionSpawn: { protocolVersions: [1] } };
            const handler = getSocketHandler(fixture.socket, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1);
            await handler({ machineId: fixture.machineId, capabilities }, vi.fn());
            const transaction = db.$transaction;
            let changed = false;
            // Advance genuine durable authority after the first database
            // snapshot closes. Neither admission nor the socket handler is mocked.
            db.$transaction = new Proxy(transaction, { async apply(target, receiver, args: unknown[]) {
                const result: unknown = await Reflect.apply(target, receiver, args);
                const captured = result && typeof result === "object" && "result" in result ? result.result : null;
                if (!changed && captured && typeof captured === "object" && "kind" in captured && captured.kind === "unchanged") {
                    changed = true;
                    await db.machine.update({ where: { id: fixture.machineId }, data: kind === "revoked"
                        ? { revokedAt: new Date() } : { installationId: randomUUID() } });
                }
                return result;
            } });
            const callback = vi.fn();
            try { await handler({ machineId: fixture.machineId, capabilities }, callback); }
            finally { db.$transaction = transaction; }
            expect(changed).toBe(true);
            expect(MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse(callback.mock.calls[0]?.[0]))
                .toEqual({ v: 1, result: "error", code: "machine_unavailable" });
            expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } }))
                .toMatchObject({ operationProtocolCapabilitiesRevision: 1 });
        });

        it("commits metadata while another writer publishes the Account", async () => {
            const metadata = encodePlainMachineStoredContent({ ...PUBLISHED_METADATA, host: "publication-host-after" });
            const fixture = await publishUnderContention(
                "machine-update-metadata",
                (current: Awaited<ReturnType<typeof createMachineFixture>>) => ({
                    machineId: current.machineId,
                    metadata,
                    expectedVersion: 0,
                    expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                }),
            );
            expect(fixture.callback).toHaveBeenCalledWith({ result: "success", version: 1, metadata });
            expect(fixture.advanced).toBe(true);
            expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } }))
                .toMatchObject({ metadata, metadataVersion: 1 });
        });

        it("commits daemon state while another writer publishes the Account", async () => {
            const daemonState = encodePlainMachineStoredContent({ status: "running" });
            const fixture = await publishUnderContention(
                "machine-update-state",
                (current: Awaited<ReturnType<typeof createMachineFixture>>) => ({
                    machineId: current.machineId,
                    daemonState,
                    expectedVersion: 0,
                    expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                }),
            );
            expect(fixture.callback).toHaveBeenCalledWith({ result: "success", version: 1, daemonState });
            expect(MachineUpdateStateResponseSchema.parse(fixture.callback.mock.calls[0]?.[0]))
                .toEqual({ result: "success", version: 1, daemonState });
            expect(fixture.advanced).toBe(true);
            expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } }))
                .toMatchObject({ daemonState, daemonStateVersion: 1 });
            await withAuthenticatedTestApp(machinesRoutes, async app => {
                const read = await app.inject({ method: "GET", url: `/v1/machines/${fixture.machineId}`,
                    headers: { "x-test-user-id": fixture.accountId, ...currentAccountStoredContentCompatibilityHeaders } });
                expect(read.statusCode).toBe(200);
                expect(MachinePublishedRowV1Schema.parse(read.json().machine))
                    .toMatchObject({ daemonState, daemonStateVersion: 1 });
            });

            const other = await createMachineFixture();
            const before = await db.machine.findUniqueOrThrow({ where: { id: other.machineId } });
            const crossedMachine = vi.fn();
            await getSocketHandler(fixture.socket, "machine-update-state")({
                machineId: other.machineId, daemonState, expectedVersion: 0,
                expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            }, crossedMachine);
            expect(MachineUpdateStateResponseSchema.parse(crossedMachine.mock.calls[0]?.[0]))
                .toMatchObject({ result: "error" });
            expect(await db.machine.findUniqueOrThrow({ where: { id: other.machineId } })).toEqual(before);
        });
    },
);
