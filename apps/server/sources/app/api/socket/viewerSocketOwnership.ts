import type { Server } from "socket.io";
import { readSocketRoomSnapshot } from './socketRoomDiscovery';

export type PeerMediationViewerSocketOwnershipVerifier = (params: Readonly<{
    accountId: string;
    socketId: string;
}>) => boolean | Promise<boolean>;

type ViewerSocketLookupIo = Pick<Server, "in" | "sockets">;

function isOwnedUserScopedSocket(
    socket: unknown,
    input: Readonly<{ accountId: string; socketId: string }>,
): boolean {
    if (!socket || typeof socket !== 'object' || !('id' in socket) || socket.id !== input.socketId) return false;
    if ('connected' in socket && socket.connected === false) return false;
    if (!('data' in socket) || !socket.data || typeof socket.data !== 'object') return false;
    return 'userId' in socket.data && socket.data.userId === input.accountId
        && 'clientType' in socket.data && socket.data.clientType === 'user-scoped';
}

export function createPeerMediationViewerSocketOwnershipVerifier(
    io: ViewerSocketLookupIo,
): PeerMediationViewerSocketOwnershipVerifier {
    return async (input) => {
        const localSocket = io.sockets.sockets.get(input.socketId);
        if (isOwnedUserScopedSocket(localSocket, input)) return true;

        try {
            const ownsSocket = (socket: unknown): boolean => isOwnedUserScopedSocket(socket, input);
            const snapshot = await readSocketRoomSnapshot({ io, room: input.socketId,
                acceptPartial: async sockets => sockets.some(ownsSocket) });
            return snapshot.sockets.some(ownsSocket);
        } catch {
            return false;
        }
    };
}
