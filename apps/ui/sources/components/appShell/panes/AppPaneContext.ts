import { createContext, useContext } from 'react';

import type { PaneDriver, PaneScopeId } from './types';
import type { AppPaneAction, AppPaneState } from './model/appPaneReducer';
import type { PaneOverlayFocusReturnOwner } from './paneOverlayFocusReturn';
import type { FileFindSeedHandoff } from './fileFindSeedHandoff';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

export type AppPaneContextValue = Readonly<{
    state: AppPaneState;
    /** Pane state remains in memory if the device could not persist its latest write. */
    persistenceFailed?: boolean;
    dispatch: (action: AppPaneAction) => void;
    registerDriver: (driver: PaneDriver) => () => void;
    getDriver: (scopeId: PaneScopeId) => PaneDriver | null;
    driverRegistryVersion: number;
    overlayFocusReturnOwner: PaneOverlayFocusReturnOwner;
    fileFindSeedHandoff: FileFindSeedHandoff;
    fileFindSeedAccountBindings: ReadonlyMap<string, ServerCredentialAccountScopeBinding>;
}>;

export const AppPaneContext = createContext<AppPaneContextValue | null>(null);
export type AppPaneFindSeedContextValue = Pick<AppPaneContextValue, 'fileFindSeedHandoff' | 'fileFindSeedAccountBindings'>;
// Launch consumers need credential/handoff changes, not every pane reducer tick.
export const AppPaneFindSeedContext = createContext<AppPaneFindSeedContextValue | null>(null);
// File origins need the stable transient focus owner, rather than every pane-state update.
export const AppPaneFocusReturnContext = createContext<PaneOverlayFocusReturnOwner | null>(null);
// Command-time driver lookup is stable; it must not subscribe the workspace to pane edits.
export const AppPaneDriverContext = createContext<AppPaneContextValue['getDriver'] | null>(null);

type FileTabFrontSubscription = Readonly<{
    subscribe: (listener: () => void) => () => void;
    read: (scopeId: string, path: string) => boolean;
}>;

export const AppPaneFileFrontContext = createContext<FileTabFrontSubscription | null>(null);

/** A read-only projection of the provider's current state, never another state owner. */
export function createFileTabFrontSubscription(readState: () => AppPaneState): FileTabFrontSubscription & Readonly<{ notify: () => void }> {
    const listeners = new Set<() => void>();
    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        read(scopeId, path) {
            const details = readState().scopes[scopeId]?.details;
            return details?.isOpen === true && details.focusedGroupId !== null
                && details.groupsById[details.focusedGroupId]?.activeTabKey === `file:${path}`;
        },
        notify() {
            for (const listener of listeners) listener();
        },
    };
}

export function useAppPaneContext(): AppPaneContextValue {
    const ctx = useContext(AppPaneContext);
    if (!ctx) throw new Error('useAppPaneContext must be used within <AppPaneProvider>');
    return ctx;
}

export function useOptionalAppPaneContext(): AppPaneContextValue | null {
    return useContext(AppPaneContext);
}

export function useOptionalAppPaneFindSeedContext(): AppPaneFindSeedContextValue | null {
    return useContext(AppPaneFindSeedContext);
}

export function useOptionalPaneFocusReturnOwner(): PaneOverlayFocusReturnOwner | null {
    return useContext(AppPaneFocusReturnContext);
}

export function useOptionalPaneDriverReader(): AppPaneContextValue['getDriver'] | null {
    return useContext(AppPaneDriverContext);
}
