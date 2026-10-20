/** Home-owned projection of acknowledged registrations, shared with cluster discovery. */
export const RPC_REGISTERED_METHODS_SOCKET_DATA_KEY = 'rpcRegisteredMethods';

export function readSocketRegisteredRpcMethods(socket: Readonly<{ data?: unknown }>): readonly string[] | null {
    const data = socket.data;
    if (!data || typeof data !== 'object') return null;
    const methods: unknown = Reflect.get(data, RPC_REGISTERED_METHODS_SOCKET_DATA_KEY);
    if (!Array.isArray(methods) || !methods.every((method): method is string => typeof method === 'string' && method.trim().length > 0)) return null;
    return methods;
}
