import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';

/** A surface follows the session's recorded machine, never its current launch/control candidate. */
export function readSessionWidgetProvidedContext(input: Readonly<{
    serverId: string; sessionId: string; session?: Session | null;
}>): Readonly<Record<string, readonly JsonValue[]>> {
    const machineId = input.session && (!input.session.serverId || input.session.serverId === input.serverId)
        ? resolveSessionMachineId(readSessionOwnerMetadataView(input.session)) : null;
    return { session: [{ serverId: input.serverId, sessionId: input.sessionId }],
        ...(machineId ? { machine: [{ serverId: input.serverId, machineId }] } : {}) };
}
