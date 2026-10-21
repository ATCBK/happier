import { isMachineReachable, readMachineRequestReachabilityObservation, type MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';

import { isMachineReplaced } from './machineIdentityTypes';
import type { ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';

/**
 * Shared machine presence fact for neutral selection presentations. It does
 * not pick a replacement or make a cached/offline machine executable.
 * Callers carry the authenticated Home and Account; an unbound scope cannot admit a request.
 */
export type MachinePickerPresence =
    | { status: 'online'; selectable: true }
    | { status: 'offline'; selectable: false; reason: 'offline' | 'home_unreachable' }
    | { status: 'revoked' | 'replaced'; selectable: false };

export function resolveMachinePickerPresence(
    machine: Readonly<{
        id: string;
        active: boolean;
        activeAt?: number | null;
        revokedAt?: number | null;
        replacedByMachineId?: string | null;
        replacedAt?: unknown;
    }>,
    nowMs: number | undefined,
    scope: MachineReachabilityScope | null | undefined,
    resolveScopeId?: ProfileScopeResolver,
): MachinePickerPresence {
    const revokedAt = typeof machine.revokedAt === 'number' ? machine.revokedAt : 0;
    if (Number.isFinite(revokedAt) && revokedAt > 0) {
        return { status: 'revoked', selectable: false };
    }

    if (isMachineReplaced(machine)) {
        return { status: 'replaced', selectable: false };
    }

    const online = isMachineReachable(scope, machine, nowMs, resolveScopeId);
    if (!online) {
        return { status: 'offline', selectable: false,
            reason: !scope || readMachineRequestReachabilityObservation(scope, machine.id, undefined, resolveScopeId)?.outcome === 'failed'
                ? 'home_unreachable' : 'offline' };
    }

    return { status: 'online', selectable: true };
}
