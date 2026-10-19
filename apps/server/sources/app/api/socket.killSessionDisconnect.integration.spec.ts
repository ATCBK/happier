import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { io as ioClient } from "socket.io-client";

import { SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT } from "@happier-dev/protocol";
import { RPC_METHODS } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { startSocket } from "./socket";
import type { Fastify as AppFastify } from "./types";

type ClientSocket = ReturnType<typeof ioClient>;

async function connect(socket: ClientSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("connect_error", reject);
        socket.connect();
    });
}

async function waitFor<T>(read: () => Promise<T | null>, label: string): Promise<T> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const value = await read();
        if (value !== null) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

describe("session-scoped killSession followed by runner disconnect", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-socket-kill-session-disconnect-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);
    afterAll(async () => await harness.close());
    beforeEach(() => harness.resetEnv());
    afterEach(async () => {
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    async function runKillThenDisconnect(runnerKillResponse: unknown) {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}` }, select: { id: true } });
        const machineId = `m-kill-${Date.now()}`;
        await db.machine.create({ data: { id: machineId, accountId: account.id, metadata: "{}" } });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: `session-${Date.now()}`,
                metadata: "{}",
                active: false,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: account.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        const token = await auth.createToken(account.id);

        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        const port = typeof address === "object" && address ? address.port : null;
        if (!port) throw new Error("Failed to bind socket server");
        const url = `http://127.0.0.1:${port}`;
        const runner = ioClient(url, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: { token, clientType: "session-scoped", sessionId: session.id, machineId },
        });
        const ui = ioClient(url, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            autoConnect: false,
            auth: { token },
        });
        const sessionUpdates: Array<Record<string, unknown>> = [];
        ui.on("update", (update: { body?: Record<string, unknown> }) => {
            if (update.body?.t === "update-session" && update.body.id === session.id) sessionUpdates.push(update.body);
        });
        const killMethod = `${session.id}:${RPC_METHODS.KILL_SESSION}`;

        try {
            runner.on(SOCKET_RPC_EVENTS.REQUEST, (request: { method?: unknown }, acknowledge: (value: unknown) => void) => {
                if (request.method === killMethod) acknowledge(runnerKillResponse);
            });
            await connect(runner);
            await new Promise<void>((resolve) => {
                runner.once(SOCKET_RPC_EVENTS.REGISTERED, () => resolve());
                runner.emit(SOCKET_RPC_EVENTS.REGISTER, { method: killMethod });
            });
            const registered = await runner.timeout(5_000).emitWithAck(SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT, {
                sessionId: session.id,
                mutationId: "register-runner",
                snapshot: { state: "active", activeCount: 1 },
            });
            expect(registered).toMatchObject({ status: "applied" });
            await expect(db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: { active: true },
            })).resolves.toEqual({ active: true });

            await connect(ui);
            const killed = await ui.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.CALL, {
                method: killMethod,
                params: "opaque-encrypted-kill-request",
            });
            expect(killed).toEqual({ ok: true, result: runnerKillResponse });
            // The acknowledgement alone proves only that the request was accepted.
            await expect(db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: { active: true },
            })).resolves.toEqual({ active: true });

            runner.close();
            // Every disconnect of the current publisher settles Activity away from `active`.
            const settled = await waitFor(async () => {
                const stored = await db.session.findUniqueOrThrow({
                    where: { id: session.id },
                    select: { active: true, runtimeActivityState: true },
                });
                return stored.runtimeActivityState === "active" ? null : stored;
            }, "disconnect settlement");
            return { settled, sessionUpdates };
        } finally {
            runner.close();
            ui.close();
            await app.close();
        }
    }

    it("closes the publisher when the runner disconnects after accepting killSession", async () => {
        // Session RPC results are end-to-end encrypted; the relay sees only the opaque acknowledgement.
        const { settled, sessionUpdates } = await runKillThenDisconnect("opaque-encrypted-requested-ack");

        expect(settled.active).toBe(false);
        await waitFor(async () => (sessionUpdates.some((body) => body.active === false) ? true : null), "inactive update");
    }, 30_000);

    it("keeps the session active when the runner rejected killSession before disconnecting", async () => {
        const { settled } = await runKillThenDisconnect({ error: "Kill failed", errorCode: "RPC_FAILED" });

        expect(settled).toEqual({ active: true, runtimeActivityState: "unknown" });
    }, 30_000);
});
