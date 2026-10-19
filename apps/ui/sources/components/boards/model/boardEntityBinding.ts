import { buildWorkBoardItemKeyV1, type BoardItemRefV1 } from '@happier-dev/protocol/boards/workBoardV1';

import { resolveServerScopedMachineInventory } from '@/sync/domains/machines/resolveServerScopedMachines';
import { readSessionListHomeObservationForServerId } from '@/sync/domains/session/listing/sessionListHomeObservation';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { isSessionRetiredForServer, type SessionsDomain } from '@/sync/store/domains/sessions';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { WorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

type BoardEntitySourceState = 'ready' | 'loading' | 'settled' | 'retired' | 'failed';

/** A settled cache miss is unavailable here, not evidence that a Session was deleted. */
export function readBoardSessionSourceState(
    state: Pick<SessionsDomain, 'sessionListRowsByServerId' | 'deletedSessionIds' | 'concurrentSessionListCacheByServerId'>,
    ref: BoardItemRefV1,
    previous?: BoardEntitySourceState,
): BoardEntitySourceState {
    const { serverId, id } = ref.qualifiedId;
    if (readSessionListRowForServerId(state.sessionListRowsByServerId, serverId, id)) return 'ready';
    if (isSessionRetiredForServer(state.deletedSessionIds, id, serverId)) return 'retired';
    const observation = readSessionListHomeObservationForServerId(state.concurrentSessionListCacheByServerId, serverId);
    if (observation?.phase === 'error' || observation?.phase === 'offline') return 'failed';
    if ((!observation || observation.phase === 'loading' || observation.phase === 'refreshing') && previous && previous !== 'loading') return previous;
    return observation && (observation.lastSuccessAt !== null || observation.phase === 'ready') ? 'settled' : 'loading';
}

type BoardSessionSource = Readonly<{ state: BoardEntitySourceState; row: SessionListRenderableSession | null }>;

/** Visit-local settled facts for the demanded Sessions. A re-read is not a new result. */
export function createBoardSessionSourceProjection() {
    let previous = new Map<string, BoardSessionSource>();
    return (state: Parameters<typeof readBoardSessionSourceState>[0], refs: readonly BoardItemRefV1[]): readonly BoardSessionSource[] => {
        const next = new Map<string, BoardSessionSource>();
        const sources = refs.map(ref => {
            const key = buildWorkBoardItemKeyV1(ref);
            const old = previous.get(key);
            const phase = readBoardSessionSourceState(state, ref, old?.state);
            const row = readSessionListRowForServerId(state.sessionListRowsByServerId, ref.qualifiedId.serverId, ref.qualifiedId.id)
                ?? (phase === 'ready' ? old?.row ?? null : null);
            const source = old?.state === phase && old.row === row ? old : { state: phase, row };
            next.set(key, source);
            return source;
        });
        previous = next;
        return sources;
    };
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
