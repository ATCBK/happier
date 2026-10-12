import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { db, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { fenceExactCurrentPublisherAuthorityInTx } from "./hasExactCurrentPublisherAuthorityInTx";
import { armPendingActivationAuthorizationInTx } from "./pendingActivationAuthorization";
import { inPendingQueuePositionTx } from "./reserveNextPendingQueuePosition";
import { setMachineAccessGrantInTx } from "@/app/machines/machineAccess";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { enqueuePendingMessage } from "./pendingMessageService";
import {
    MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent,
} from "@happier-dev/protocol";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Session and Account lock order", () => {
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing disposable PostgreSQL contract DATABASE_URL");
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each(["committed", "standalone"] as const)("replays before the Session guard when %s activation changes to a lower managed controller Account", async targetSource => {
        const stem = `pending-target-race-${randomUUID()}`;
        const custodian = await db.account.create({ data: { id: `${stem}-a`, encryptionMode: "plain" } });
        const requester = await db.account.create({ data: { id: `${stem}-z`, encryptionMode: "plain" } });
        const homeId = `srv_${"f".repeat(32)}`;
        vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", homeId);
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "3");
        vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY", "optional");
        let allowInitialLock!: () => void;
        const targetMayChange = new Promise<void>(resolve => { allowInitialLock = resolve; });
        let discovered!: () => void;
        const oldTargetDiscovered = new Promise<void>(resolve => { discovered = resolve; });
        let accountLocked!: () => void;
        const requesterLocked = new Promise<void>(resolve => { accountLocked = resolve; });
        let allowRevalidation!: () => void;
        const peerMayWait = new Promise<void>(resolve => { allowRevalidation = resolve; });
        const rawDriverFailures: unknown[] = [];
        let interceptInitialLock = true;
        let pendingPid = -1;
        let peerPid = -1;
        let peerFinished = false;
        const transaction = db.$transaction.bind(db);
        let pendingResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
        let peerResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
        try {
            const makeMachine = (accountId: string, active: boolean) => db.machine.create({ data: {
                id: randomUUID(), accountId, installationId: randomUUID(), active,
                metadata: encodePlainMachineStoredContent({ host: "target-race", platform: "linux", happyCliVersion: "test",
                    homeDir: "/home/test", happyHomeDir: "/home/test/.happier" }),
                dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, "base64")),
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            const previous = await makeMachine(requester.id, true);
            const controller = await makeMachine(custodian.id, true);
            const guest = await makeMachine(custodian.id, false);
            for (const machine of [controller, guest]) expect(await inTx(tx => setMachineAccessGrantInTx(tx, {
                actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: "account", accountId: requester.id }, level: "admin",
            }), { isolationLevel: "ReadCommitted" })).toMatchObject({ kind: "saved", readiness: "ready" });
            await db.managedMachine.create({ data: {
                homeId, custodianAccountId: custodian.id, controllerMachineId: controller.id,
                controllerInstallationId: controller.installationId!, admittedActionRequestId: randomUUID(), admittedInput: {},
                allocation: "bound", creationState: "active", enrolledMachineId: guest.id, desired: "stop",
                launch: { provider: { pluginId: "fixture.compute", localId: "vm" }, schemaVersion: 1, name: "Retained", choices: {} },
                resource: { contributionRef: { pluginId: "fixture.compute", localId: "vm" }, schemaVersion: 1, value: {} },
                retention: { kind: "until-delete" }, wakeOnAcceptedMessage: true,
                observation: { observedAt: 1, availability: "present", power: "stopped", storage: "retained" },
            } });
            const session = await db.session.create({ data: {
                accountId: requester.id, tag: stem, metadata: "{}", encryptionMode: "plain", active: false,
            } });
            for (const machine of [previous, guest]) await db.accessKey.create({ data: {
                accountId: requester.id, machineId: machine.id, sessionId: session.id, data: "private-key-ciphertext",
            } });
            const target = (machine: typeof guest) => ({ homeId, accountId: requester.id, sessionId: session.id,
                machineId: machine.id, installationId: machine.installationId! });
            const requestId = randomUUID();
            const receipt = (machine: typeof guest) => ({ v: 1, issuer: "authenticatedAccount", actorAccountId: requester.id,
                sessionRelationship: "owner", admittedTarget: target(machine) });
            await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: target(previous) } });
            if (targetSource === "standalone") await db.sessionPendingMessage.create({ data: {
                sessionId: session.id, localId: requestId, position: 1, content: { t: "plain", v: {} },
                messageRole: "user", authorAccountId: requester.id, requestedAction: { v: 1, kind: "send_now" },
                inputAdmissionReceipt: receipt(previous),
            } });
            // Only the real PostgreSQL transport is intercepted. Keep the global
            // default unchanged while exercising this exact owner under RC.
            const execute = async <T>(fn: (tx: Tx) => Promise<T>, options?: { maxWait?: number; timeout?: number }) => transaction(async tx => {
                const observed = new Proxy(tx, { get(boundary, key) {
                    if (key === "$queryRawUnsafe") return async <R>(query: string, ...values: unknown[]): Promise<R> => {
                        const pause = interceptInitialLock && query.includes('FROM "Account"')
                            && query.includes("FOR NO KEY UPDATE") && Array.isArray(values[0])
                            && values[0].includes(requester.id) && !values[0].includes(custodian.id);
                        if (pause) {
                            interceptInitialLock = false;
                            const [backend] = await boundary.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
                            pendingPid = backend.pid;
                            discovered();
                            await targetMayChange;
                        }
                        try {
                            const result = await boundary.$queryRawUnsafe<R>(query, ...values);
                            if (pause) { accountLocked(); await peerMayWait; }
                            return result;
                        } catch (error) { rawDriverFailures.push(error); throw error; }
                    }
                    const member: unknown = Reflect.get(boundary, key, boundary);
                    return typeof member === "function" ? member.bind(boundary) : member;
                } });
                return fn(observed);
            }, { ...options, isolationLevel: "ReadCommitted" });
            // Prisma's overload includes batch arrays; inTx uses its interactive
            // callback overload, which this transport adapter preserves.
            db.$transaction = execute as typeof db.$transaction;
            const pending = targetSource === "standalone"
                ? inTx(tx => armPendingActivationAuthorizationInTx({ tx, sessionId: session.id, requestId }))
                : enqueuePendingMessage({ actorUserId: requester.id, sessionId: session.id, localId: requestId,
                    content: { t: "plain", v: { role: "user", content: "race" } }, requestedAction: { v: 1, kind: "send_now" },
                    authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] } });
            pendingResult = Promise.allSettled([pending]);
            await Promise.race([oldTargetDiscovered, pendingResult.then(() => { throw new Error("Pending ended before target discovery"); })]);
            await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: target(guest) } });
            if (targetSource === "standalone") await db.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId: session.id, localId: requestId } },
                data: { inputAdmissionReceipt: receipt(guest) },
            });
            allowInitialLock();
            await Promise.race([requesterLocked, pendingResult.then(() => { throw new Error("Pending ended before Account acquisition"); })]);
            const peer = inTx(async tx => {
                const [backend] = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
                peerPid = backend.pid;
                await acquireSessionAccountCursorLocksInTx(tx, [], [custodian.id, requester.id]);
                await markAccountChanged(tx, { accountId: requester.id, kind: "account", entityId: stem });
            }, { isolationLevel: "ReadCommitted" });
            peerResult = Promise.allSettled([peer]).finally(() => { peerFinished = true; });
            while (!peerFinished) {
                const [blocking] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                    "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS waiting", pendingPid, peerPid,
                );
                if (blocking.waiting) break;
            }
            expect(peerFinished).toBe(false);
            allowRevalidation();
            const outcomes = [...await pendingResult, ...await peerResult];
            expect(rawDriverFailures).toEqual([]);
            for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
            if (targetSource === "committed") expect(outcomes[0], JSON.stringify(outcomes[0])).toMatchObject({
                status: "fulfilled", value: { ok: true, didWrite: true },
            });
            const row = await db.sessionPendingMessage.findUniqueOrThrow({ where: {
                sessionId_localId: { sessionId: session.id, localId: requestId },
            } });
            expect(row).toMatchObject({ messageRole: "user", authorAccountId: requester.id,
                inputAdmissionReceipt: { admittedTarget: target(guest) } });
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
                pendingActivationRequestId: true, pendingActivationStatus: true,
            } })).toEqual({ pendingActivationRequestId: requestId, pendingActivationStatus: "waiting" });
            expect(await db.accountChange.findMany({ where: { accountId: custodian.id, kind: "machine", entityId: controller.id } }))
                .toHaveLength(1);
        } finally {
            allowInitialLock?.(); allowRevalidation?.();
            await Promise.all([pendingResult, peerResult]);
            db.$transaction = transaction;
            vi.unstubAllEnvs();
            await db.accessKey.deleteMany({ where: { accountId: requester.id } });
            await db.session.deleteMany({ where: { accountId: requester.id } });
            await db.managedMachine.deleteMany({ where: { custodianAccountId: custodian.id } });
            await db.machine.deleteMany({ where: { accountId: { in: [custodian.id, requester.id] } } });
            await db.account.deleteMany({ where: { id: { in: [custodian.id, requester.id] } } });
        }
    });

    it.each(["explicit", "committed", "standalone", "explicit-unenrolled"] as const)("waits for a foreign target Account before locking the Pending Session through %s admission", async targetSource => {
        const custodian = await db.account.create({ data: { encryptionMode: "plain" } });
        const requester = await db.account.create({ data: { encryptionMode: "plain" } });
        const homeId = `srv_${"f".repeat(32)}`;
        vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", homeId);
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
        let releaseController!: () => void;
        const controllerMayContinue = new Promise<void>(resolve => { releaseController = resolve; });
        let controllerReady!: () => void;
        const controllerHasAccount = new Promise<void>(resolve => { controllerReady = resolve; });
        let controllerPid = -1;
        const transaction = db.$transaction.bind(db);
        try {
            const machine = (active: boolean) => db.machine.create({ data: {
                id: randomUUID(), accountId: custodian.id, installationId: randomUUID(), active,
                metadata: encodePlainMachineStoredContent({ host: "lock-order", platform: "linux", happyCliVersion: "test",
                    homeDir: "/home/test", happyHomeDir: "/home/test/.happier" }),
                dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, "base64")),
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
                operationProtocolCapabilitiesRevision: 1,
            } });
            const controller = await machine(true);
            const guest = await machine(false);
            for (const target of [controller, guest]) {
                expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                    machineId: target.id, principal: { kind: "account", accountId: requester.id }, level: "admin" })))
                    .toMatchObject({ kind: "saved", readiness: "ready" });
            }
            if (targetSource !== "explicit-unenrolled") await db.managedMachine.create({ data: {
                homeId, custodianAccountId: custodian.id, controllerMachineId: controller.id,
                controllerInstallationId: controller.installationId!, admittedActionRequestId: randomUUID(), admittedInput: {},
                allocation: "bound", creationState: "active", enrolledMachineId: guest.id, desired: "stop",
                launch: { provider: { pluginId: "fixture.compute", localId: "vm" }, schemaVersion: 1, name: "Retained", choices: {} },
                resource: { contributionRef: { pluginId: "fixture.compute", localId: "vm" }, schemaVersion: 1, value: {} },
                retention: { kind: "until-delete" }, wakeOnAcceptedMessage: true,
                observation: { observedAt: 1, availability: "present", power: "stopped", storage: "retained" },
            } });
            const session = await db.session.create({ data: {
                accountId: requester.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain", active: false,
            } });
            await db.accessKey.create({ data: {
                accountId: requester.id, machineId: guest.id, sessionId: session.id, data: "private-key-ciphertext",
            } });
            const admittedTarget = { homeId, accountId: requester.id, sessionId: session.id,
                machineId: guest.id, installationId: guest.installationId! };
            if (targetSource === "committed") {
                await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: admittedTarget } });
            }
            const requestId = randomUUID();
            await db.sessionPendingMessage.create({ data: {
                sessionId: session.id, localId: requestId, position: 1, content: { t: "plain", v: {} },
                messageRole: "user", authorAccountId: requester.id, requestedAction: { v: 1, kind: "send_now" },
                inputAdmissionReceipt: { v: 1, issuer: "authenticatedAccount", actorAccountId: requester.id,
                    sessionRelationship: "owner", admittedTarget },
            } });
            const execute = async <T>(fn: (tx: Tx) => Promise<T>, options?: { maxWait?: number; timeout?: number }) =>
                transaction(fn, { ...options, isolationLevel: "ReadCommitted" });
            // Only the interactive PostgreSQL transport is adapted; this file
            // exercises RC without changing the product's global default.
            db.$transaction = execute as typeof db.$transaction;
            const holder = inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, custodian.id);
                const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
                controllerPid = row.pid;
                controllerReady();
                await controllerMayContinue;
            }, { isolationLevel: "ReadCommitted" });
            const holderResult = Promise.allSettled([holder]);
            await controllerHasAccount;
            let pendingFinished = false;
            const arm = (tx: Tx) =>
                armPendingActivationAuthorizationInTx({ tx, sessionId: session.id, requestId });
            const pending = targetSource === "standalone"
                ? inTx(arm)
                : inPendingQueuePositionTx(session.id, arm, targetSource.startsWith("explicit") ? guest.id : undefined);
            const pendingResult = Promise.allSettled([pending]).finally(() => { pendingFinished = true; });
            try {
                while (!pendingFinished) {
                    const [row] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting",
                        controllerPid,
                    );
                    if (row.waiting) break;
                }
                expect(pendingFinished).toBe(false);
                await expect(inTx(tx => tx.$queryRawUnsafe<{ id: string }[]>(
                    'SELECT "id" FROM "Session" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', session.id,
                ), { isolationLevel: "ReadCommitted" })).resolves.toEqual([{ id: session.id }]);
            } finally { releaseController(); }
            for (const outcome of await holderResult) if (outcome.status === "rejected") throw outcome.reason;
            const [outcome] = await pendingResult;
            if (outcome.status === "rejected") throw outcome.reason;
            if (targetSource === "explicit-unenrolled") expect(outcome.value?.machinePublication)
                .toMatchObject({ target: admittedTarget, custodianAccountId: custodian.id });
            else expect(outcome.value?.managedControllerPublication)
                .toMatchObject({ accountId: custodian.id, cursor: expect.any(Number) });
        } finally {
            releaseController?.();
            db.$transaction = transaction;
            vi.unstubAllEnvs();
            await db.accessKey.deleteMany({ where: { accountId: requester.id } });
            await db.session.deleteMany({ where: { accountId: requester.id } });
            await db.managedMachine.deleteMany({ where: { custodianAccountId: custodian.id } });
            await db.machine.deleteMany({ where: { accountId: custodian.id } });
            await db.account.deleteMany({ where: { id: { in: [custodian.id, requester.id] } } });
        }
    });

    it("commits a mode-fenced publisher write and cursor publication without a reciprocal lock cycle", async () => {
        const account = await db.account.create({ data: { publicKey: `lock-order-${randomUUID()}` } });
        let releaseOwner!: () => void;
        const ownerMayContinue = new Promise<void>(resolve => { releaseOwner = resolve; });
        try {
            const machine = await db.machine.create({ data: {
                id: randomUUID(), accountId: account.id, metadata: "{}", installationId: randomUUID(),
            } });
            const session = await db.session.create({ data: {
                accountId: account.id, tag: randomUUID(), metadata: "{}",
            } });
            await db.accessKey.create({ data: {
                accountId: account.id, machineId: machine.id, sessionId: session.id, data: "encrypted",
            } });
            const presence = createSessionPublisherPresence();
            const registered = await presence.registerPublisher({
                socket: {}, binding: { accountId: account.id, machineId: machine.id, sessionId: session.id },
                completeActivitySnapshot: { state: "unknown", activeCount: 0 },
            });
            if (registered.status !== "registered") throw new Error("Publisher fixture did not register");
            const authority = { accountId: account.id, machineId: machine.id, sessionId: session.id,
                committedFence: registered.committedFence };
            const before = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
            const timestamps = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
                lastActiveAt: true, updatedAt: true,
            } });
            vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
            let ownerReady!: () => void;
            const ownerHasAccount = new Promise<void>(resolve => { ownerReady = resolve; });
            const owner = inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id);
                ownerReady();
                await ownerMayContinue;
                expect(await fenceExactCurrentPublisherAuthorityInTx(tx, authority, account.id, session.id)).toBe(true);
                return markAccountChanged(tx, { accountId: account.id, kind: "session", entityId: session.id });
            }, { isolationLevel: "ReadCommitted" });
            // Attach rejection handlers immediately; the deadlock victim is an expected RED outcome.
            const ownerResult = Promise.allSettled([owner]);
            await ownerHasAccount;
            let publisherPid = -1;
            let publisherFenced = false;
            let publisherFinished = false;
            const publisher = inTx(async tx => {
                const rows = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
                publisherPid = rows[0].pid;
                expect(await fenceExactCurrentPublisherAuthorityInTx(tx, authority, account.id, session.id)).toBe(true);
                publisherFenced = true;
                return markAccountChanged(tx, { accountId: account.id, kind: "session", entityId: session.id });
            }, { isolationLevel: "ReadCommitted" });
            const publisherResult = Promise.allSettled([publisher]).finally(() => { publisherFinished = true; });
            try {
                // Before the fix, publisher owns Session and then waits on Account.
                // After the fix, it waits on Account before touching Session. Observe
                // that real boundary rather than holding it behind an artificial barrier.
                while (!publisherFenced && !publisherFinished) {
                    const waiting = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock') AS waiting",
                        publisherPid,
                    );
                    if (waiting[0].waiting) break;
                }
            } finally { releaseOwner(); }
            const outcomes = [...await ownerResult, ...await publisherResult];
            for (const outcome of outcomes) {
                if (outcome.status === "rejected") throw outcome.reason;
            }
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: before.seq + 2 });
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: {
                lastActiveAt: true, updatedAt: true,
            } })).toEqual(timestamps);
        } finally {
            releaseOwner?.();
            vi.unstubAllEnvs();
            await db.accessKey.deleteMany({ where: { accountId: account.id } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
