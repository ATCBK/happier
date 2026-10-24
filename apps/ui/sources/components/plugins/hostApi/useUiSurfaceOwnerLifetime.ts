import * as React from 'react';

/** Bind an existing physical owner to React without treating layout detachment as retirement. */
export function useUiSurfaceOwnerLifetime(owner: Readonly<{
    isCurrent(): boolean;
    retire(): void;
    dispose(): void;
}> | null): void {
    const attached = React.useRef<typeof owner>(null);
    React.useInsertionEffect(() => () => owner?.retire(), [owner]);
    React.useLayoutEffect(() => () => {
        if (owner && !owner.isCurrent()) owner.dispose();
    }, [owner]);
    React.useEffect(() => {
        if (!owner) return;
        attached.current = owner;
        return () => {
            if (attached.current === owner) attached.current = null;
            if (!owner.isCurrent()) { owner.dispose(); return; }
            // Fabric can omit insertion/layout cleanup for an already-hidden
            // subtree. StrictMode reconnects passive effects synchronously;
            // only a still-detached exact owner is finalized one microtask later.
            queueMicrotask(() => {
                if (attached.current === owner) return;
                owner.retire();
                owner.dispose();
            });
        };
    }, [owner]);
}
