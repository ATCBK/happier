import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { getStorage } from '@/sync/domains/state/storageStore';
import { sessionListRuntimeClock } from '@/hooks/session/sessionListRuntimeClock';

import { createProjectsTreeCheckoutFactsSelector } from './projectsTreeCheckoutFacts';
import type { ProjectsTreeCheckoutFacts } from './projectsTreeRows';

/**
 * The live facts of one set of checkouts: one selector, one store/clock subscription shared by every
 * reader. Readers pick their own checkouts' facts (`useProjectsTreeCheckoutFactsFor`) and re-render only
 * when those change; nothing here subscribes until a reader mounts.
 */
export type ProjectsTreeCheckoutFactsSource = Readonly<{
    getSnapshot: () => ReadonlyMap<string, ProjectsTreeCheckoutFacts>;
    subscribe: (listener: () => void) => () => void;
}>;

function createProjectsTreeCheckoutFactsSource(
    refs: readonly WorkspaceRefV1[],
    store: ReturnType<typeof getStorage>,
): ProjectsTreeCheckoutFactsSource {
    const select = createProjectsTreeCheckoutFactsSelector(refs);
    let nowMs = refs.length > 0 ? Math.max(sessionListRuntimeClock.getNowMs(), Date.now()) : Date.now();
    const getSnapshot = () => select(store.getState(), nowMs);
    const listeners = new Set<() => void>();
    let stop: (() => void) | null = null;
    const start = () => {
        const token = {};
        let published = getSnapshot();
        const refresh = () => {
            nowMs = Math.max(sessionListRuntimeClock.getNowMs(), Date.now());
            const next = getSnapshot();
            // Re-arm even when a heartbeat extends freshness without changing
            // the visible facts. Only this source's deadline can wake its readers.
            const wakeAtMs = select.getNextWakeAtMs();
            if (wakeAtMs === null) sessionListRuntimeClock.clearWake(token);
            else sessionListRuntimeClock.requestWake(token, wakeAtMs);
            // The selector keeps the Map identity while no checkout's facts changed.
            if (next === published) return;
            published = next;
            for (const listener of [...listeners]) listener();
        };
        const stopClock = sessionListRuntimeClock.subscribeWake(token, refresh);
        const stopStore = store.subscribe(refresh);
        refresh();
        return () => {
            stopStore();
            stopClock();
        };
    };
    const subscribe = (listener: () => void) => {
        if (refs.length === 0) return () => {};
        listeners.add(listener);
        stop ??= start();
        return () => {
            listeners.delete(listener);
            if (listeners.size > 0) return;
            stop?.();
            stop = null;
        };
    };
    return { getSnapshot, subscribe };
}

/** Mount only with the rendered Projects tree; no catalog fetch, SCM discovery or registration. */
export function useProjectsTreeCheckoutFactsSource(refs: readonly WorkspaceRefV1[]): ProjectsTreeCheckoutFactsSource {
    const store = getStorage();
    return React.useMemo(() => createProjectsTreeCheckoutFactsSource(refs, store), [refs, store]);
}

/** Every checkout's facts; re-renders on any change. Per-row readers use `useProjectsTreeCheckoutFactsFor`. */
export function useProjectsTreeCheckoutFacts(refs: readonly WorkspaceRefV1[]): ReadonlyMap<string, ProjectsTreeCheckoutFacts> {
    const source = useProjectsTreeCheckoutFactsSource(refs);
    return React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

/** The facts of `keys`, in order (null while unknown). The reader re-renders only when one of them changes. */
export function useProjectsTreeCheckoutFactsFor(
    source: ProjectsTreeCheckoutFactsSource,
    keys: readonly string[],
): readonly (ProjectsTreeCheckoutFacts | null)[] {
    const pick = useShallow((facts: ReadonlyMap<string, ProjectsTreeCheckoutFacts>) => keys.map(key => facts.get(key) ?? null));
    const getSnapshot = () => pick(source.getSnapshot());
    return React.useSyncExternalStore(source.subscribe, getSnapshot, getSnapshot);
}
