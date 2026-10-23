export function buildRpcMethodRoom(params: Readonly<{
    userId: string;
    method: string;
}>): string {
    if (!params.userId) {
        throw new Error("buildRpcMethodRoom: userId is required");
    }
    if (!params.method) {
        throw new Error("buildRpcMethodRoom: method is required");
    }
    return `rpc:${params.userId}:${params.method}`;
}

/** Positive reconnect hints, indexed by the registration owner rather than the Account census. */
export function buildMachineRpcAvailabilityRoom(params: Readonly<{ userId: string; machineId: string }>): string {
    if (!params.userId || !params.machineId) throw new Error('buildMachineRpcAvailabilityRoom: userId and machineId are required');
    return `rpc-machine-availability:${params.userId}:${params.machineId}`;
}
