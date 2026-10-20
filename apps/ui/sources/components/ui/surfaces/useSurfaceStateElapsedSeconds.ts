import * as React from 'react';

/** Mount in a visible status leaf so the loading clock never rerenders the containing page. */
export function useSurfaceStateElapsedSeconds(): number {
    const [elapsedMs, setElapsedMs] = React.useState(0);
    React.useEffect(() => {
        const startedAt = Date.now();
        const interval = setInterval(() => setElapsedMs(Date.now() - startedAt), 1_000);
        return () => clearInterval(interval);
    }, []);
    return Math.floor(elapsedMs / 1_000);
}
