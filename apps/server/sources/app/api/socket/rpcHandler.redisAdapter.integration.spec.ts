import http from "node:http";

import { createAdapter } from "@socket.io/redis-streams-adapter";
import { RPC_ERROR_CODES } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";

import { startRedisAdapterRecoveryCluster } from "@/testkit/redisAdapterRecoveryCluster";

import { readRedisStreamsAdapterOptionsFromEnv } from "@/config/socketAdapter";

import { resolveRedisAdapterValidationRedisUrl } from "../../../../scripts/resolveRedisAdapterValidationRedisUrl";
import { registerSocketRpcHandlers } from "./rpc/registerSocketRpcHandlers";
import { buildRpcMethodRoom } from "./rpc/rpcMethodRoom";

const USER_ID = "user-redis-adapter";
const SOCKET_PATH = "/v1/updates";

function registerTestRpcHandlers(io: Server): void {
    io.on('connection', socket => {
        // This transport fixture supplies the identity normally admitted by startSocket.
        socket.data.authAuthority = 'present_user';
        socket.data.authTokenAuthenticationEvidence = [];
        registerSocketRpcHandlers({ userId: USER_ID, socket, io });
    });
}

type RedisMemoryInstance = Awaited<ReturnType<typeof resolveRedisAdapterValidationRedisUrl>>["redisMemory"];

type StartedCluster = Readonly<{
    ioA: Server;
    ioB: Server;
    redisA: Redis;
    redisB: Redis;
    redisMemory: RedisMemoryInstance;
    portA: number;
    portB: number;
    close: () => Promise<void>;
}>;

async function listen(server: http.Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address && typeof address === "object") {
        return address.port;
    }
    throw new Error("Failed to determine server port");
}

async function closeServer(server: http.Server): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startCluster(): Promise<StartedCluster> {
    const { redisUrl, redisMemory } = await resolveRedisAdapterValidationRedisUrl({
        env: process.env,
    });

    const redisA = new Redis(redisUrl);
    const redisB = new Redis(redisUrl);
    const httpA = http.createServer();
    const httpB = http.createServer();
    const ioA = new Server(httpA, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        serveClient: false,
        adapter: createAdapter(redisA, readRedisStreamsAdapterOptionsFromEnv({})),
    });
    const ioB = new Server(httpB, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        serveClient: false,
        adapter: createAdapter(redisB, readRedisStreamsAdapterOptionsFromEnv({})),
    });

    registerTestRpcHandlers(ioA);
    registerTestRpcHandlers(ioB);

    const portA = await listen(httpA);
    const portB = await listen(httpB);

    return {
        ioA,
        ioB,
        redisA,
        redisB,
        redisMemory,
        portA,
        portB,
        close: async () => {
            await ioA.close();
            await ioB.close();
            await closeServer(httpA);
            await closeServer(httpB);
            await redisA.quit();
            await redisB.quit();
            if (redisMemory) {
                await redisMemory.stop();
            }
        },
    };
}

async function connectClient(port: number): Promise<ClientSocket> {
    const socket = createClient(`http://127.0.0.1:${port}`, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        timeout: 5_000,
    });

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout connecting socket client on port ${port}`)), 6_000);
        socket.once("connect", () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once("connect_error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });

    return socket;
}

async function emitWithAck<TResponse>(
    socket: ClientSocket,
    event: string,
    payload: unknown,
): Promise<TResponse> {
    return await new Promise<TResponse>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ack for ${event}`)), 6_000);
        socket.emit(event, payload, (response: TResponse) => {
            clearTimeout(timer);
            resolve(response);
        });
    });
}

async function waitForEvent<TPayload>(socket: ClientSocket, event: string): Promise<TPayload> {
    return await new Promise<TPayload>((resolve) => {
        socket.once(event, (payload: TPayload) => resolve(payload));
    });
}

async function waitForCondition(
    predicate: () => Promise<boolean>,
    timeoutMs = 6_000,
    pollMs = 25,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error("Timed out waiting for condition");
}

describe("rpcHandler redis adapter integration", () => {
    const startedClusters: StartedCluster[] = [];
    const startedClients: ClientSocket[] = [];

    afterEach(async () => {
        while (startedClients.length > 0) {
            startedClients.pop()?.disconnect();
        }
        while (startedClusters.length > 0) {
            await startedClusters.pop()?.close();
        }
    });

    it.each(["restart", "silent partition"] as const)("recovers remote RPC discovery, calls and no-target after Redis %s", async (failure) => {
        const cluster = await startRedisAdapterRecoveryCluster();
        const [nodeA, nodeB] = cluster.nodes;
        registerTestRpcHandlers(nodeA.io);
        registerTestRpcHandlers(nodeB.io);
        const caller = await connectClient(nodeA.port);
        const listener = await connectClient(nodeB.port);
        try {
            const callerId = caller.id;
            const listenerId = listener.id;
            const method = "agent.recovery";
            const room = buildRpcMethodRoom({ userId: USER_ID, method });
            listener.on(SOCKET_RPC_EVENTS.REQUEST, (request, respond) => respond(request.params));
            const registered = waitForEvent(listener, SOCKET_RPC_EVENTS.REGISTERED);
            listener.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
            await registered;
            const assertCall = async (phase: string) => {
                expect((await nodeA.io.in(room).fetchSockets()).map((socket) => socket.id)).toEqual([listenerId]);
                expect(await emitWithAck(caller, SOCKET_RPC_EVENTS.CALL, { method, params: { phase } }))
                    .toEqual({ ok: true, result: { phase } });
            };
            await assertCall("before");
            await cluster.recover(failure);
            expect(caller.id).toBe(callerId);
            expect(listener.id).toBe(listenerId);
            await assertCall("after");
            listener.disconnect();
            await waitForCondition(async () => (await nodeA.io.in(room).fetchSockets()).length === 0);
            expect(await emitWithAck(caller, SOCKET_RPC_EVENTS.CALL, { method, params: {} }))
                .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        } finally {
            caller.disconnect();
            listener.disconnect();
            await cluster.close();
        }
    }, 60_000);

    it("routes room-based RPC calls across redis-adapter-backed server instances", async () => {
        const cluster = await startCluster();
        startedClusters.push(cluster);

        const caller = await connectClient(cluster.portA);
        const listener = await connectClient(cluster.portB);
        startedClients.push(caller, listener);

        const method = "agent.run";
        listener.on(SOCKET_RPC_EVENTS.REQUEST, (request, respond) => {
            respond({
                ok: true,
                responder: "server-b",
                method: (request as { method: string }).method,
                params: (request as { params: unknown }).params,
            });
        });

        const registered = waitForEvent<{ method: string }>(listener, SOCKET_RPC_EVENTS.REGISTERED);
        listener.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
        await expect(registered).resolves.toEqual({ method });

        const response = await emitWithAck<{ ok: boolean; result?: unknown }>(
            caller,
            SOCKET_RPC_EVENTS.CALL,
            {
                method,
                params: { source: "caller-a" },
            },
        );

        expect(response).toEqual({
            ok: true,
            result: {
                ok: true,
                responder: "server-b",
                method,
                params: { source: "caller-a" },
            },
        });
    });

    it("returns METHOD_NOT_AVAILABLE once the remote listener disconnects and leaves no stale room target", async () => {
        const cluster = await startCluster();
        startedClusters.push(cluster);

        const caller = await connectClient(cluster.portA);
        const listener = await connectClient(cluster.portB);
        startedClients.push(caller, listener);

        const method = "agent.run";
        const room = buildRpcMethodRoom({ userId: USER_ID, method });

        listener.on(SOCKET_RPC_EVENTS.REQUEST, (_request, respond) => {
            respond({ ok: true, responder: "server-b" });
        });

        const registered = waitForEvent<{ method: string }>(listener, SOCKET_RPC_EVENTS.REGISTERED);
        listener.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
        await expect(registered).resolves.toEqual({ method });

        listener.disconnect();

        await waitForCondition(async () => {
            const [targetsA, targetsB] = await Promise.all([
                cluster.ioA.in(room).fetchSockets(),
                cluster.ioB.in(room).fetchSockets(),
            ]);
            return targetsA.length === 0 && targetsB.length === 0;
        });

        const response = await emitWithAck<{ ok: boolean; error?: string; errorCode?: string }>(
            caller,
            SOCKET_RPC_EVENTS.CALL,
            {
                method,
                params: { source: "caller-a" },
            },
        );

        expect(response).toEqual({
            ok: false,
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    });

});
