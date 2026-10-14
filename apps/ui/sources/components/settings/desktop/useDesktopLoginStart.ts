import * as React from 'react';

import {
    readLocalDaemonSharedState,
    subscribeLocalDaemonSharedState,
} from '@/components/settings/machines/localControl/localDaemonSharedState';
import {
    type DesktopServiceAutostartMode,
    type LocalDaemonStatusData,
} from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import { setDesktopLoginStartMode } from './desktopLoginStart';
import { t } from '@/text';
import { isDesktopHost } from '@/utils/platform/desktopHost';

/**
 * The one login-start setting (R16 b): whether this computer's background services start at login.
 * The CLI's service mode is the fact; the app's own login item follows it natively (starting the
 * app in the menu bar), and Quit keeps or stops the services by it — there is no separate app
 * toggle to disagree with it.
 *
 * `mode` is `null` while nothing proved one mode for every managed service (no status yet, an
 * unreadable inventory, or services in different modes): unknown stays unknown and offers nothing
 * to flip.
 */
export type DesktopLoginStartState = Readonly<{
    supported: boolean;
    mode: DesktopServiceAutostartMode | null;
    /** Whether a managed background service is installed here; `null` when presence is unproved. */
    installed: boolean | null;
    loading: boolean;
    error: string | null;
    setMode: (mode: DesktopServiceAutostartMode) => Promise<void>;
}>;

export function useDesktopLoginStart(): DesktopLoginStartState {
    const supported = React.useMemo(() => isDesktopHost(), []);
    const runner = React.useMemo(() => getDefaultSystemTaskRunner(), []);
    // The status every surface describing this computer shares; this row starts no read of its own.
    const subscribe = React.useCallback((listener: () => void) => subscribeLocalDaemonSharedState(runner, listener), [runner]);
    const readStatus = React.useCallback(() => readLocalDaemonSharedState<LocalDaemonStatusData>(runner).status, [runner]);
    const status = React.useSyncExternalStore(subscribe, readStatus, readStatus);
    const [writing, setWriting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const setMode = React.useCallback(async (mode: DesktopServiceAutostartMode) => {
        if (!supported) return;
        setWriting(true);
        setError(null);
        try {
            await setDesktopLoginStartMode(runner, mode);
        } catch (nextError) {
            setError(nextError instanceof Error && nextError.message ? nextError.message : t('settings.systemTaskStartFailed'));
        } finally {
            setWriting(false);
        }
    }, [runner, supported]);

    return {
        supported,
        // A13-02: the setting is every managed service's common mode, not the scoped service's.
        mode: status?.serviceAutostart ?? null,
        // Whether the app manages any background service here (the setting has nothing to govern otherwise).
        installed: status?.managedServiceInstalled ?? null,
        loading: supported && (writing || status === null),
        error,
        setMode,
    };
}
