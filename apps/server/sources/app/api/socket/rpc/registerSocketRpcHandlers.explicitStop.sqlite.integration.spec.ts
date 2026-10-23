import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";

import { RPC_ERROR_CODES, RPC_METHODS } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import { SessionForkRpcResultSchema } from "@happier-dev/protocol/sessions/fork";

import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from "../../testkit/socketHarness";
import { registerSocketRpcHandlers } from "./registerSocketRpcHandlers";

describe("explicit machine stop RPC on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-dev-explicit-stop-rpc-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    it.each([RPC_METHODS.SESSION_FORK, RPC_METHODS.SESSION_FORK_PROVIDER_SAFE,
        RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY, RPC_METHODS.SESSION_AGENT_TRANSITION])(
        "registers and relays Machine-owned lifecycle %s only with source Session authority", async rpcMethod => {
            const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
            const machineId = `machine-${randomUUID()}`;
            await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}" } });
            const other = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
            const foreignSession = await db.session.create({ data: { accountId: other.id, tag: randomUUID(), metadata: "{}" } });
            const method = `${machineId}:${rpcMethod}`;
            const result = SessionForkRpcResultSchema.parse({ ok: true, childSessionId: "child-created" });
            const targetEffect = vi.fn(async () => result);
            const join = vi.fn(async (_room: string) => {});
            const daemon = Object.assign(createFakeSocket({ id: "lifecycle-daemon", data: { clientType: "machine-scoped", machineId },
                timeout: () => ({ emitWithAck: targetEffect }) }), { join });
            // Socket.IO is the network boundary; registration, relay admission and SQLite access stay real.
            const io = createSocketRoomDiscoveryHarness(async () => [daemon]);
            registerSocketRpcHandlers({ userId: owner.id, socket: daemon as unknown as Socket, io });
            await triggerSocketHandler(daemon, SOCKET_RPC_EVENTS.REGISTER, { method });
            expect(daemon.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
            expect(join).toHaveBeenCalled();

            const caller = createFakeSocket({ data: { clientType: "user-scoped", authAuthority: "present_user", authTokenAuthenticationEvidence: [] } });
            registerSocketRpcHandlers({ userId: owner.id, socket: caller as unknown as Socket, io });
            const callback = vi.fn();
            for (const authorization of [undefined, { kind: "session.write", sessionId: foreignSession.id }]) {
                await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: "opaque-lifecycle-request", authorization }, callback);
                expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
            }
            expect(targetEffect).not.toHaveBeenCalled();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: "opaque-lifecycle-request",
                authorization: { kind: "session.write", sessionId: session.id } }, callback);
            expect(callback).toHaveBeenLastCalledWith({ ok: true, result });
            expect(targetEffect).toHaveBeenCalledOnce();
        },
    );

    it("marks the exact session inactive only after the daemon proves it stopped", async () => {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });

        const presence = createSessionPublisherPresence();
        const registered = await presence.registerPublisher({
            socket: {},
            binding: { accountId: owner.id, machineId, sessionId: session.id },
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected publisher registration");

        const method = `${machineId}:${RPC_METHODS.STOP_SESSION}`;
        const targetEmitWithAck = vi.fn().mockResolvedValue({
            v: 1,
            result: "opaque-encrypted-stop-result",
            acknowledgement: {
                kind: "session.stop",
                status: "stopped",
            },
        });
        const target = {
            id: "target-socket",
            data: { clientType: "machine-scoped", machineId },
            timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
        };
        const io = createSocketRoomDiscoveryHarness(async () => [target]);
        const caller = createFakeSocket({
            id: "caller-socket",
            data: {
                clientType: "user-scoped",
                authAuthority: "present_user",
                authTokenAuthenticationEvidence: [],
            },
        });
        const callback = vi.fn();

        registerSocketRpcHandlers({
            userId: owner.id,
            socket: caller as unknown as Socket,
            io,
            sessionPublisherPresence: presence,
        });
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque-encrypted-stop-request",
            authorization: {
                kind: "session.write",
                sessionId: session.id,
            },
        }, callback);

        expect(targetEmitWithAck).toHaveBeenCalledOnce();
        expect(targetEmitWithAck).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.REQUEST,
            {
                method,
                params: "opaque-encrypted-stop-request",
                callerAuthority: "present_user",
                authorization: {
                    kind: "session.write",
                    sessionId: session.id,
                },
                timeoutMs: 30_000,
                transportResponseEnvelopeVersion: 1,
            },
        );
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: "opaque-encrypted-stop-result",
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { active: true },
        })).resolves.toEqual({ active: false });

        const replacementPublisherSocket = {};
        const replacementRegistered = await presence.registerPublisher({
            socket: replacementPublisherSocket,
            binding: { accountId: owner.id, machineId, sessionId: session.id },
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (replacementRegistered.status !== "registered") {
            throw new Error("expected replacement publisher registration");
        }
        targetEmitWithAck.mockResolvedValueOnce("opaque-encrypted-incomplete-result");
        callback.mockClear();

        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque-encrypted-second-stop-request",
            authorization: {
                kind: "session.write",
                sessionId: session.id,
            },
        }, callback);

        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: "opaque-encrypted-incomplete-result",
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { active: true },
        })).resolves.toEqual({ active: true });
    });
});
