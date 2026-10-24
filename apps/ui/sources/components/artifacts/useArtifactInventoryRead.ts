import * as React from 'react';

import { sync } from '@/sync/sync';

/**
 * The Artifact inventory read as a surface sees it: while `enabled` it asks the sync owner for the
 * list (`sync.fetchArtifactsList`, the read that publishes `artifactsLoaded`), reports whether that
 * read failed, and `retry` reads again. A surface that waits on the inventory enables it only while
 * the inventory is unknown; one that opens as the intent to refresh it stays enabled.
 */
export function useArtifactInventoryRead(enabled: boolean): Readonly<{ failed: boolean; retry: () => void }> {
    const [failed, setFailed] = React.useState(false);
    const retry = React.useCallback(() => {
        setFailed(false);
        void sync.fetchArtifactsList().then(() => setFailed(false), () => setFailed(true));
    }, []);
    React.useEffect(() => {
        if (enabled) retry();
    }, [enabled, retry]);
    return { failed, retry };
}
