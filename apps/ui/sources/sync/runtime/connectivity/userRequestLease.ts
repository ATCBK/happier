export type UserRequestLeaseOwner = Readonly<{
    acquire(): () => void;
    hasActiveLease(): boolean;
    deferRoutineTeardown(teardown: () => void): boolean;
    cancelDeferredRoutineTeardown(): void;
    crossHardBoundary(teardown: () => void): void;
}>;

/**
 * The visibility/socket owner for in-flight user requests. Routine backgrounding
 * waits for requests to settle; explicit disconnect, pagehide, and freeze never do.
 */
export function createUserRequestLeaseOwner(): UserRequestLeaseOwner {
    const activeLeases = new Set<() => void>();
    let deferredRoutineTeardown: (() => void) | null = null;

    const releaseOne = (release: () => void) => {
        if (!activeLeases.delete(release)) return;
        if (activeLeases.size !== 0 || deferredRoutineTeardown === null) return;

        const teardown = deferredRoutineTeardown;
        deferredRoutineTeardown = null;
        teardown();
    };

    return {
        acquire() {
            const release = () => { releaseOne(release); };
            activeLeases.add(release);
            return release;
        },
        hasActiveLease() {
            return activeLeases.size > 0;
        },
        deferRoutineTeardown(teardown) {
            if (activeLeases.size === 0) {
                teardown();
                return false;
            }
            deferredRoutineTeardown = teardown;
            return true;
        },
        cancelDeferredRoutineTeardown() {
            deferredRoutineTeardown = null;
        },
        crossHardBoundary(teardown) {
            activeLeases.clear();
            deferredRoutineTeardown = null;
            teardown();
        },
    };
}

// Sync's visibility policy and ApiSocket's acknowledgement lifecycle share one
// owner. Transport requests must hold the same lease as longer UI operations.
export const userRequestLeaseOwner = createUserRequestLeaseOwner();
