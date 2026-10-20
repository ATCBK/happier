import * as React from 'react';

/** One-shot wake at the instant the Activity owner says its projection expires. */
export function useActivityBoundaryRefresh(nextBoundaryMs: number | null, refresh: () => void): void {
    React.useEffect(() => {
        if (nextBoundaryMs === null) return undefined;
        const timeoutId = setTimeout(refresh, Math.max(0, nextBoundaryMs - Date.now()));
        return () => clearTimeout(timeoutId);
    }, [nextBoundaryMs, refresh]);
}
