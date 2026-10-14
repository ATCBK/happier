import type { VerifiedEphemeralSessionRunnerPrincipal } from "@happier-dev/protocol/ephemeralRunner/principal";
import { resolveEphemeralRunnerMachineRpcAuthority } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';

import type { SocketClientType } from "../socketRooms";
import type { VerifiedApiTokenPrincipal } from "@/app/auth/auth";

export type RestrictedSocketAdmission =
    | Readonly<{ kind: "session-runtime"; principal: VerifiedEphemeralSessionRunnerPrincipal }>
    | Readonly<{ kind: "machine-runtime"; principal: VerifiedEphemeralSessionRunnerPrincipal }>
    | Readonly<{ kind: "api-token-session-viewer"; principal: VerifiedApiTokenPrincipal; sessionId: string }>;

export function canEphemeralRunnerMachineRegisterRpcMethod(params: Readonly<{
    admission: RestrictedSocketAdmission;
    method: string;
}>): boolean {
    if (params.admission.kind !== "machine-runtime") return false;
    const prefix = `${params.admission.principal.machineId}:`;
    if (!params.method.startsWith(prefix)) return false;
    const method = params.method.slice(prefix.length);
    return resolveEphemeralRunnerMachineRpcAuthority(method) !== null;
}

/**
 * Runner credentials are valid for exactly two existing socket compositions:
 * their materialized Session publisher and their exact ephemeral Machine RPC
 * receiver. Requiring the Machine on the Session socket keeps both transports
 * bound to the materializer's one AccessKey tuple.
 */
export function resolveRestrictedSocketAdmission(params: Readonly<{
    principal: VerifiedEphemeralSessionRunnerPrincipal | null | undefined;
    apiTokenPrincipal?: VerifiedApiTokenPrincipal | null;
    clientType: SocketClientType;
    sessionId?: string;
    machineId?: string;
}>): RestrictedSocketAdmission | null {
    const principal = params.principal;
    if (params.apiTokenPrincipal) {
        return !principal && params.clientType === "session-scoped" && params.sessionId
            && params.machineId === undefined
            ? { kind: "api-token-session-viewer", principal: params.apiTokenPrincipal, sessionId: params.sessionId }
            : null;
    }
    if (!principal) return null;

    if (
        params.clientType === "session-scoped"
        && params.sessionId === principal.sessionId
        && params.machineId === principal.machineId
    ) {
        return { kind: "session-runtime", principal };
    }

    if (
        params.clientType === "machine-scoped"
        && params.machineId === principal.machineId
        && params.sessionId === undefined
    ) {
        return { kind: "machine-runtime", principal };
    }

    return null;
}
