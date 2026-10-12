import type { Server } from "socket.io";

import { readMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { recordSocketClusterFetchSockets } from "@/app/monitoring/metrics/index";
import { log } from "@/utils/logging/log";
import { db } from "@/storage/db";
import { getMachineSocketRoom } from "../../socketRooms";

import type { RpcAckResponseEmitter } from "./_types";
import { buildRpcMethodRoom } from "./rpcMethodRoom";

function classifySocketClusterFetchFailureReason(error: unknown): "timeout" | "transport" | "unknown" {
    if (!(error instanceof Error)) {
        return "unknown";
    }
    const message = error.message.toLowerCase();
    return message.includes("timeout") ? "timeout" : "unknown";
}

/** Distinguish a missing daemon from a missing method using authenticated Machine-room membership. */
export async function isMachineRpcTargetUnavailable(params: Readonly<{
    io: Server;
    userId: string;
    method: string;
    fetchTimeoutMs?: number;
}>): Promise<boolean> {
    const separator = params.method.indexOf(':');
    if (separator <= 0) return false;
    const machineId = params.method.slice(0, separator);
    try {
        // Session and Machine RPC namespaces share the transport. Only the canonical Machine
        // row establishes that this namespace denotes a Machine, including legacy installations.
        const machine = await db.machine.findFirst({
            where: { accountId: params.userId, id: machineId },
            select: { id: true },
        });
        if (!machine) return false;
        const room = params.io.in(getMachineSocketRoom(params.userId, machineId));
        const targets = typeof params.fetchTimeoutMs === 'number' && params.fetchTimeoutMs > 0
            ? await room.timeout(params.fetchTimeoutMs).fetchSockets() as RpcAckResponseEmitter[]
            : await room.fetchSockets() as RpcAckResponseEmitter[];
        return !targets.some(target => target.data?.clientType === 'machine-scoped'
            && target.data.machineId === machineId);
    } catch {
        // A failed cluster/DB lookup is not affirmative evidence that a daemon disconnected.
        log({ module: 'websocket-rpc', level: 'warn', machineId }, 'Machine RPC daemon presence lookup failed');
        return false;
    }
}

export async function discoverRpcTargets(params: Readonly<{
    io: Server;
    userId: string;
    method: string;
    fetchTimeoutMs?: number;
}>): Promise<RpcAckResponseEmitter[]> {
    const room = buildRpcMethodRoom({
        userId: params.userId,
        method: params.method,
    });
    const startedAt = Date.now();

    try {
        const targets = typeof params.fetchTimeoutMs === "number" && params.fetchTimeoutMs > 0
            ? await params.io.in(room).timeout(params.fetchTimeoutMs).fetchSockets() as RpcAckResponseEmitter[]
            : await params.io.in(room).fetchSockets() as RpcAckResponseEmitter[];
        recordSocketClusterFetchSockets({
            durationMs: Date.now() - startedAt,
            result: "ok",
        });
        const availableTargets: RpcAckResponseEmitter[] = [];
        for (const target of targets) {
            const clientType = typeof target.data?.clientType === "string" ? target.data.clientType : "";
            const machineId = typeof target.data?.machineId === "string" ? target.data.machineId : "";
            if (clientType !== "machine-scoped" || !machineId) {
                availableTargets.push(target);
                continue;
            }
            const state = await readMachineAvailabilityState({ accountId: params.userId, machineId });
            if (state === "available") {
                availableTargets.push(target);
            }
        }
        return availableTargets;
    } catch (error) {
        recordSocketClusterFetchSockets({
            durationMs: Date.now() - startedAt,
            result: "error",
            reason: classifySocketClusterFetchFailureReason(error),
        });
        log(
            { module: "websocket-rpc", level: "warn", room },
            `RPC target discovery failed for ${room}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
    }
}
