import * as React from 'react';
import { Platform } from 'react-native';

import { warmRepositoryDirectoryCache } from '@/sync/domains/input/repositoryDirectory';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { fireAndForget } from '@/utils/system/fireAndForget';

export function useWarmRepositoryDirectoryCacheOnSessionOpen(input: Readonly<{
    sessionId: string;
    sessionPath: string | null;
    machineOnline: boolean;
}>) {
    const enabledSetting = useSetting('filesRepositoryTreeWarmCacheEnabled');
    const enabled = enabledSetting === true;

    const sessionKey = `${input.sessionId}:${input.sessionPath ?? ''}`;
    const didWarmRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!enabled) return;
        if (Platform.OS !== 'web') return;
        if (!input.sessionId) return;
        if (!input.sessionPath) return;
        if (!input.machineOnline) return;
        if (didWarmRef.current === sessionKey) return;
        didWarmRef.current = sessionKey;
        const controller = new AbortController();
        fireAndForget(
            warmRepositoryDirectoryCache({ sessionId: input.sessionId, directoryPath: '', signal: controller.signal }).catch(error => {
                if (!controller.signal.aborted) throw error;
            }),
            { tag: 'useWarmRepositoryDirectoryCacheOnSessionOpen.warmRoot' }
        );
        return () => {
            controller.abort();
            if (didWarmRef.current === sessionKey) didWarmRef.current = null;
        };
    }, [enabled, input.machineOnline, input.sessionId, input.sessionPath, sessionKey]);
}
