import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { io as ioClient } from "socket.io-client";
import type { Redis } from "ioredis";

import { SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT } from "@happier-dev/protocol";
import { RPC_METHODS } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { getRedisClient } from "@/storage/redis/redis";
import { startSocket } from "./socket";
import type { Fastify as AppFastify } from "./types";

// startSocket only closes its Socket.IO server from the process shutdown hook; capture it so each test
// node can stop its cluster-adapter polling instead of leaking it into the next test.
const socketShutdownHooks: Array<() => Promise<void>> = [];
vi.mock("@/utils/process/shutdown", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/utils/process/shutdown")>()),
    onShutdown: (name: string, callback: () => Promise<void>) => {
        if (name === "api:socket") socketShutdownHooks.push(callback);
        return () => {};
    },
}));

// Two server instances in one test process would otherwise share the process-wide Redis client. The
// streams adapter reads with a blocking XREAD from offset `$`, so one node's XADD queued behind the other
// node's XREAD on the same connection is never observed. Production instances are separate processes
// with separate connections; give each test node its own connection to match.
const adapterRedisClients: Redis[] = [];
vi.mock("@socket.io/redis-streams-adapter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@socket.io/redis-streams-adapter")>();
    return {
        ...actual,
        createAdapter: (client: Redis, options?: Parameters<typeof actual.createAdapter>[1]) => {
            const dedicated = client.duplicate();
            adapterRedisClients.push(dedicated);
            return actual.createAdapter(dedicated, options);
        },
    };
});

type ClientSocket = ReturnType<typeof ioClient>;

async function connect(socket: ClientSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("connect_error", reject);
        socket.connect();
    });
}

async function startNode(): Promise<{ url: string; close: () => Promise<void> }> {
    const app = Fastify({ logger: false }) as unknown as AppFastify;
    startSocket(app);
    const closeSocketServer = socketShutdownHooks.pop();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : null;
    if (!port) throw new Error("Failed to bind socket server");
    return {
        url: `http://127.0.0.1:${port}`,
        close: async () => {
            await closeSocketServer?.();
            await app.close();
        },
    };
}

async function seedRunnerSession() {
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
    return { sessionId: session.id, machineId, token };
}

function createRunner(url: string, seeded: Awaited<ReturnType<typeof seedRunnerSession>>): ClientSocket {
    return ioClient(url, {
        path: "/v1/updates",
        transports: ["websocket"],
        reconnection: false,
        autoConnect: false,
        auth: { token: seeded.token, clientType: "session-scoped", sessionId: seeded.sessionId, machineId: seeded.machineId },
    });
}

function createUi(url: string, token: string): ClientSocket {
    return ioClient(url, {
        path: "/v1/updates",
        transports: ["websocket"],
        reconnection: false,
        autoConnect: false,
        auth: { token },
    });
}

/** Connects the runner, registers its killSession handler, and makes it the session's current publisher. */
async function connectRegisteredRunner(params: Readonly<{
    runner: ClientSocket;
    sessionId: string;
    killMethod: string;
    killResponse: unknown;
}>): Promise<void> {
    const { runner, sessionId, killMethod, killResponse } = params;
    runner.on(SOCKET_RPC_EVENTS.REQUEST, (request: { method?: unknown }, acknowledge: (value: unknown) => void) => {
        if (request.method === killMethod) acknowledge(killResponse);
    });
    await connect(runner);
    await new Promise<void>((resolve) => {
        runner.once(SOCKET_RPC_EVENTS.REGISTERED, () => resolve());
        runner.emit(SOCKET_RPC_EVENTS.REGISTER, { method: killMethod });
    });
    const registered = await runner.timeout(5_000).emitWithAck(SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT, {
        sessionId,
        mutationId: "register-runner",
        snapshot: { state: "active", activeCount: 1 },
    });
    expect(registered).toMatchObject({ status: "applied" });
    await expect(db.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { active: true },
    })).resolves.toEqual({ active: true });
}

async function waitForDisconnectSettlement(sessionId: string) {
    return await waitFor(async () => {
        const stored = await db.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: { active: true, runtimeActivityState: true },
        });
        return stored.runtimeActivityState === "active" ? null : stored;
    }, "disconnect settlement");
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

describe("session-scoped killSession followed by runner disconnect", () => {
    async function runKillThenDisconnect(runnerKillResponse: unknown) {
        const seeded = await seedRunnerSession();
        const node = await startNode();
        const runner = createRunner(node.url, seeded);
        const ui = createUi(node.url, seeded.token);
        const sessionUpdates: Array<Record<string, unknown>> = [];
        ui.on("update", (update: { body?: Record<string, unknown> }) => {
            if (update.body?.t === "update-session" && update.body.id === seeded.sessionId) sessionUpdates.push(update.body);
        });
        const killMethod = `${seeded.sessionId}:${RPC_METHODS.KILL_SESSION}`;

        try {
            await connectRegisteredRunner({ runner, sessionId: seeded.sessionId, killMethod, killResponse: runnerKillResponse });

            await connect(ui);
            const killed = await ui.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.CALL, {
                method: killMethod,
                params: "opaque-encrypted-kill-request",
            });
            expect(killed).toEqual({ ok: true, result: runnerKillResponse });
            // The acknowledgement alone proves only that the request was accepted.
            await expect(db.session.findUniqueOrThrow({
                where: { id: seeded.sessionId },
                select: { active: true },
            })).resolves.toEqual({ active: true });

            runner.close();
            // Every disconnect of the current publisher settles Activity away from `active`.
            const settled = await waitForDisconnectSettlement(seeded.sessionId);
            return { settled, sessionUpdates };
        } finally {
            runner.close();
            ui.close();
            await node.close();
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

async function findFreePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
        });
    });
}

/** Starts a throwaway local `redis-server` (an external system boundary) for the cluster-adapter test. */
async function startLocalRedis(): Promise<{ url: string; process: ChildProcess }> {
    const port = await findFreePort();
    const child = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], {
        stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`redis-server exited early (${code})`)));
        child.stdout?.on("data", (chunk: Buffer) => {
            if (chunk.toString().includes("Ready to accept connections")) resolve();
        });
    });
    return { url: `redis://127.0.0.1:${port}`, process: child };
}

// Real Redis is required for the cross-instance RPC registry and streams adapter. Use REDIS_URL when the
// lane provides one, otherwise a local `redis-server`; skip only when neither exists.
const externalRedisUrl = process.env.REDIS_URL?.trim() || null;
const hasLocalRedisServer = spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!externalRedisUrl && !hasLocalRedisServer)("session-scoped killSession relayed to a runner on another Redis-adapter instance", () => {
    let redisUrl: string;
    let localRedis: ChildProcess | null = null;

    beforeAll(async () => {
        if (externalRedisUrl) {
            redisUrl = externalRedisUrl;
            return;
        }
        const started = await startLocalRedis();
        redisUrl = started.url;
        localRedis = started.process;
    }, 30_000);
    afterAll(async () => {
        await Promise.all(adapterRedisClients.map(async (client) => await client.quit()));
        await getRedisClient().quit();
        localRedis?.kill();
    });
    beforeEach(() => harness.resetEnv({ HAPPIER_SOCKET_ADAPTER: "redis-streams", REDIS_URL: redisUrl }));

    it("closes the publisher on the runner's instance when the runner disconnects after accepting", async () => {
        const seeded = await seedRunnerSession();
        const runnerNode = await startNode();
        const callerNode = await startNode();
        const runner = createRunner(runnerNode.url, seeded);
        const ui = createUi(callerNode.url, seeded.token);
        const killMethod = `${seeded.sessionId}:${RPC_METHODS.KILL_SESSION}`;

        try {
            await connectRegisteredRunner({
                runner,
                sessionId: seeded.sessionId,
                killMethod,
                killResponse: "opaque-encrypted-requested-ack",
            });

            await connect(ui);
            const killed = await ui.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.CALL, {
                method: killMethod,
                params: "opaque-encrypted-kill-request",
            });
            expect(killed).toEqual({ ok: true, result: "opaque-encrypted-requested-ack" });
            // The runner's instance learns about the accepted stop over the adapter stream after the
            // acknowledgement. A real runner spends this long in cleanup; one that exits before the mark
            // lands still settles only through the presence timeout (an accepted race).
            await new Promise((resolve) => setTimeout(resolve, 1_000));

            runner.close();
            // Without the cross-instance mark the runner instance treats this as a plain disconnect and
            // the session stays active until the presence timeout.
            const settled = await waitForDisconnectSettlement(seeded.sessionId);
            expect(settled.active).toBe(false);
        } finally {
            runner.close();
            ui.close();
            await callerNode.close();
            await runnerNode.close();
        }
    }, 30_000);
});
