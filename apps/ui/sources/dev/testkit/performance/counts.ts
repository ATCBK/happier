import { useLayoutEffect } from 'react';

export function createRenderCommitCounter() {
    let renders = 0;
    let commits = 0;
    return {
        render: () => { renders += 1; },
        commit: () => { commits += 1; },
        read: () => ({ renders, commits }),
        reset: () => { renders = 0; commits = 0; },
    };
}

export function useRenderCommitCounter(counter: ReturnType<typeof createRenderCommitCounter>) {
    counter.render();
    useLayoutEffect(counter.commit);
}

export function countStoreNotifications<State extends object>(store: {
    subscribe: (listener: (state: State, previous: State) => void) => () => void;
}) {
    const notifications: (keyof State)[][] = [];
    const stop = store.subscribe((state, previous) => {
        const keys = new Set([...Object.keys(previous), ...Object.keys(state)] as (keyof State)[]);
        notifications.push([...keys].filter(key => !Object.is(previous[key], state[key])));
    });
    return {
        read: (): readonly (readonly (keyof State)[])[] => notifications.map(keys => [...keys]),
        reset: () => { notifications.length = 0; },
        stop,
    };
}

export function countTransportRequests<Args extends unknown[], Result>(
    transport: (...args: Args) => Result,
    identify: (...args: Args) => string,
) {
    const counts = new Map<string, number>();
    return {
        request: (...args: Args): Result => {
            const key = identify(...args);
            counts.set(key, (counts.get(key) ?? 0) + 1);
            return transport(...args);
        },
        read: (): Readonly<Record<string, number>> => Object.fromEntries(counts),
        reset: () => { counts.clear(); },
    };
}
