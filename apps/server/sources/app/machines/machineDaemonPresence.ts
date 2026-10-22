import { getUserMachinesSocketRoom } from "@/app/api/socketRooms";
import { readSocketRoomSnapshot, type SocketRoomDiscoveryServer, type SocketRoomSnapshot } from '@/app/api/socket/socketRoomDiscovery';

export type MachineDaemonPresenceSocketServer = SocketRoomDiscoveryServer;

export interface MachineDaemonSocketIdentity {
    readonly accountId: string;
    readonly machineId: string;
}

export type MachineDaemonPresenceInventory =
    | Readonly<{ state: "known" | "partial"; machineIds: ReadonlySet<string> }>
    | Readonly<{ state: "unavailable" }>;

export function classifyMachineDaemonPresence(
    inventory: MachineDaemonPresenceInventory, machineId: string,
): 'connected' | 'disconnected' | 'unknown' {
    if (inventory.state !== 'unavailable' && inventory.machineIds.has(machineId)) return 'connected' as const;
    return inventory.state === 'known' ? 'disconnected' as const : 'unknown' as const;
}

/**
 * Reads only the ordinary authenticated Machine-scoped socket identity. Reserved server-origin
 * methods add their own installation-proof requirement at their dispatch boundary.
 */
export function readMachineDaemonSocketIdentity(socketData: unknown): MachineDaemonSocketIdentity | null {
    if (!socketData || typeof socketData !== "object" || Array.isArray(socketData)) {
        return null;
    }

    const data = socketData as Record<string, unknown>;
    if (data.clientType !== "machine-scoped") {
        return null;
    }
    if (typeof data.userId !== "string" || data.userId.length === 0) {
        return null;
    }
    if (typeof data.machineId !== "string" || data.machineId.length === 0) {
        return null;
    }

    return { accountId: data.userId, machineId: data.machineId };
}

/**
 * Takes one adapter-aware snapshot of the Account's Machine room. Partial observations prove
 * only the returned identities; a missing identity remains unknown until the census completes.
 */
export async function getMachineDaemonPresenceInventory(params: Readonly<{
    accountId: string;
    io: MachineDaemonPresenceSocketServer;
}>): Promise<MachineDaemonPresenceInventory> {
    let snapshot: SocketRoomSnapshot;
    try {
        // Ephemeral machine-runtime sockets intentionally do not join this daemon room.
        snapshot = await readSocketRoomSnapshot({ io: params.io, room: getUserMachinesSocketRoom(params.accountId) });
    } catch {
        return { state: "unavailable" };
    }

    const machineIds = new Set<string>();
    for (const socket of snapshot.sockets) {
        const identity = readMachineDaemonSocketIdentity(socket.data);
        if (identity?.accountId === params.accountId) {
            machineIds.add(identity.machineId);
        }
    }

    if (!snapshot.complete && machineIds.size === 0) return { state: 'unavailable' };
    return { state: snapshot.complete ? 'known' : 'partial', machineIds };
}
