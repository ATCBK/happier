import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { createEntityDragDropRuntime } from './entityDragDropRuntime';
import type { EntityDragDropRuntime, EntityDragSource, EntityDropTarget } from './entityDragDropTypes';

// Every mounted consumer in this UI realm uses this owner, including hosted plugin adapters.
const realmRuntime = createEntityDragDropRuntime();
export function useEntityDragDropRuntime(): EntityDragDropRuntime { return realmRuntime; }

/** Subscribe in feedback leaves, never in a virtualized list/screen model. Pointer frames are separate. */
export function useEntityDragDropSnapshot(runtime: EntityDragDropRuntime = realmRuntime) {
    return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
}

export function useEntityDragPointer(runtime: EntityDragDropRuntime = realmRuntime) {
    return useSyncExternalStore(runtime.subscribePointer, runtime.getPointer, runtime.getPointer);
}

/** Only an open chooser observes destination semantics; pointer frames do not rerender its host. */
export function useEntityDragDestinations(runtime: EntityDragDropRuntime, sourceId: string, enabled: boolean) {
    const key = useSyncExternalStore(runtime.subscribe, () => enabled ? JSON.stringify(runtime.getDestinations(sourceId)) : '', () => '');
    return useMemo(() => enabled ? runtime.getDestinations(sourceId) : [], [runtime, sourceId, enabled, key]);
}

export function useEntityDragSourceState(runtime: EntityDragDropRuntime, sourceId: string) {
    const phase = useSyncExternalStore(runtime.subscribe, () => {
        const snapshot = runtime.getSnapshot();
        return snapshot.sourceId === sourceId ? snapshot.phase : 'idle';
    }, () => 'idle' as const);
    return useMemo(() => ({ phase, active: phase === 'carrying' || phase === 'pending' }), [phase]);
}

export function useEntityDropTargetState(runtime: EntityDragDropRuntime, targetId: string) {
    return useSyncExternalStore(runtime.subscribe, () => {
        const snapshot = runtime.getSnapshot();
        return snapshot.targetId === targetId ? snapshot : null;
    }, () => null);
}

/** Callback refs keep registration stable across row renders while reading current owner data. */
export function useEntityDragSource(runtime: EntityDragDropRuntime, source: EntityDragSource, enabled = true): void {
    const current = useRef(source);
    current.current = source;
    useEffect(() => {
        if (!enabled) return;
        return runtime.registerSource({
            id: source.id, scope: source.scope,
            getItem: () => current.current.getItem(),
            describe: () => current.current.describe?.() ?? null,
            getBounds: () => current.current.getBounds?.() ?? null,
            isCurrent: () => current.current.id === source.id
                && current.current.scope.serverId === source.scope.serverId
                && current.current.scope.accountId === source.scope.accountId
                && current.current.isCurrent(),
        });
    }, [runtime, source.id, source.scope.serverId, source.scope.accountId, enabled]);
}

export function useEntityDropTarget(runtime: EntityDragDropRuntime, target: EntityDropTarget): void {
    const current = useRef(target);
    current.current = target;
    useEffect(() => runtime.registerTarget({
        id: target.id,
        ...(target.scopeMode === 'source' ? { scopeMode: 'source' as const } : { scope: target.scope, scopeMode: target.scopeMode }),
        get acceptedKinds() { return current.current.acceptedKinds; },
        get captureKinds() { return current.current.captureKinds; },
        get parentId() { return current.current.parentId; },
        get listDestinations() { return current.current.listDestinations; },
        getBounds: () => current.current.getBounds(),
        getClearBounds: () => current.current.getClearBounds?.() ?? null,
        get measureBounds() { return current.current.measureBounds; },
        containsPointer: pointer => current.current.containsPointer?.(pointer) !== false,
        isCurrent: () => current.current.id === target.id
            && current.current.scopeMode === target.scopeMode
            && current.current.scope?.serverId === target.scope?.serverId
            && current.current.scope?.accountId === target.scope?.accountId
            && current.current.isCurrent?.() !== false,
        resolve: context => current.current.resolve(context),
        get getDestinationKey() { return current.current.getDestinationKey; },
        execute: (effect, context) => current.current.execute(effect, context),
        autoscroll: pointer => current.current.autoscroll?.(pointer),
    }), [runtime, target.id, target.scopeMode, target.scope?.serverId, target.scope?.accountId]);
}
