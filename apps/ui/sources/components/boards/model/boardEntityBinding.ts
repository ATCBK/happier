import type { BoardItemRefV1 } from '@happier-dev/protocol/boards/workBoardV1';

import { resolveServerScopedMachineInventory } from '@/sync/domains/machines/resolveServerScopedMachines';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { isSessionRetiredForServer, type SessionsDomain } from '@/sync/store/domains/sessions';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { WorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';

type BoardEntitySourceState = 'ready' | 'loading' | 'settled' | 'retired';

/** A settled cache miss is unavailable here, not evidence that a Session was deleted. */
export function readBoardSessionSourceState(
    state: Pick<SessionsDomain, 'sessionListRowsByServerId' | 'deletedSessionIds' | 'concurrentSessionListCacheByServerId'>,
    ref: BoardItemRefV1,
): BoardEntitySourceState {
    const { serverId, id } = ref.qualifiedId;
    if (readSessionListRowForServerId(state.sessionListRowsByServerId, serverId, id)) return 'ready';
    if (isSessionRetiredForServer(state.deletedSessionIds, id, serverId)) return 'retired';
    const key = Object.keys(state.concurrentSessionListCacheByServerId)
        .find(key => areServerProfileIdentifiersEquivalent(key, serverId));
    const observation = key ? state.concurrentSessionListCacheByServerId[key]?.listObservation : null;
    return observation && (observation.lastSuccessAt !== null || observation.phase === 'ready'
        || observation.phase === 'error' || observation.phase === 'offline') ? 'settled' : 'loading';
}

export function readBoardMachineSourceState(state: Readonly<{
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
}>, ref: BoardItemRefV1): BoardEntitySourceState {
    const inventory = resolveServerScopedMachineInventory<Machine>({
        serverId: ref.qualifiedId.serverId, activeServerId: '', activeMachines: [],
        machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId,
    });
    if (inventory.machines?.some(machine => machine.id === ref.qualifiedId.id)) return 'ready';
    return inventory.status === 'error' || inventory.status === 'signedOut'
        || inventory.status === 'idle' && inventory.machines !== null ? 'settled' : 'loading';
}

type PagedEntitySource = Pick<WorkflowRunWindow, 'status' | 'hasMore' | 'loadingMore' | 'loadMoreFailed'>;

/** The Workflow and Run readers own continuation and failure; the Board consumes that same lifecycle. */
export function readBoardPagedEntitySourceState(source: PagedEntitySource): 'settled' | 'loading' {
    return source.status === 'failed' || source.loadMoreFailed || source.status === 'loaded' && !source.hasMore
        ? 'settled' : 'loading';
}

export function shouldLoadNextBoardEntityPage(source: PagedEntitySource, missing: boolean): boolean {
    return missing && source.status === 'loaded' && source.hasMore && !source.loadingMore && !source.loadMoreFailed;
}
