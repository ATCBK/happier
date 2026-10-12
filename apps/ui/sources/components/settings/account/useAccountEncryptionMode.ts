import * as React from 'react';

import { useOptionalAuth } from '@/auth/context/AuthContext';
import {
    fetchAccountEncryptionMode,
    getAccountEncryptionModeCacheRevision,
    getCachedAccountEncryptionMode,
    subscribeAccountEncryptionModeCacheInvalidation,
} from '@/sync/api/account/apiAccountEncryptionMode';

/**
 * The focused Account's persisted `encryptionMode` (the authority for "End-to-end encrypted"; key
 * presence is not): the cache owner's last answer at once, then one read through that owner, re-read
 * when it invalidates. `null` until the Account answers; a failed read keeps it unknown.
 */
export function useAccountEncryptionMode(options: Readonly<{ enabled?: boolean }> = {}): 'e2ee' | 'plain' | null {
    const enabled = options.enabled !== false;
    const credentials = useOptionalAuth()?.credentials ?? null;
    const revision = React.useSyncExternalStore(
        subscribeAccountEncryptionModeCacheInvalidation,
        getAccountEncryptionModeCacheRevision,
        getAccountEncryptionModeCacheRevision,
    );
    const [mode, setMode] = React.useState<'e2ee' | 'plain' | null>(
        () => (credentials && enabled ? getCachedAccountEncryptionMode(credentials) : null),
    );

    React.useEffect(() => {
        if (!credentials || !enabled) {
            setMode(null);
            return undefined;
        }
        let current = true;
        void fetchAccountEncryptionMode(credentials).then(
            (result) => { if (current) setMode(result.mode); },
            // Not answered (offline, unreachable Home): the mode stays unknown; nothing waits on it.
            () => undefined,
        );
        return () => {
            current = false;
        };
    }, [credentials, enabled, revision]);

    return mode === 'e2ee' || mode === 'plain' ? mode : null;
}
