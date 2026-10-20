import { getUserMachinesSocketRoom } from "@/app/api/socketRooms";

interface MachineDaemonSocketCarrier {
    readonly data?: unknown;
}

interface MachineDaemonSocketRoom {
    fetchSockets(): Promise<readonly MachineDaemonSocketCarrier[]>;
}

export interface MachineDaemonPresenceSocketServer {
    in(room: string): MachineDaemonSocketRoom;
}

export interface MachineDaemonSocketIdentity {
    readonly accountId: string;
    readonly machineId: string;
}

export type MachineDaemonPresenceInventory =
    | Readonly<{ state: "known"; machineIds: ReadonlySet<string> }>
    | Readonly<{ state: "unavailable" }>;

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
 * Takes one adapter-aware snapshot of the Account's Machine room. A transport failure is unknown presence,
 * distinct from a successfully observed empty room.
 */
export async function getMachineDaemonPresenceInventory(params: Readonly<{
    accountId: string;
    io: MachineDaemonPresenceSocketServer;
}>): Promise<MachineDaemonPresenceInventory> {
    let sockets: readonly MachineDaemonSocketCarrier[];
    try {
        // Ephemeral machine-runtime sockets intentionally do not join this daemon room.
        sockets = await params.io.in(getUserMachinesSocketRoom(params.accountId)).fetchSockets();
    } catch {
        return { state: "unavailable" };
    }

    const machineIds = new Set<string>();
    for (const socket of sockets) {
        const identity = readMachineDaemonSocketIdentity(socket.data);
        if (identity?.accountId === params.accountId) {
            machineIds.add(identity.machineId);
        }
    }

    return { state: "known", machineIds };
}
