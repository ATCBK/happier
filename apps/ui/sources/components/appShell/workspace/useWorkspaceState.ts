import * as React from 'react';
import { Platform } from 'react-native';
import { getStorage, useActiveServerAccountScope, useIsDataReady, useLocalSetting } from '@/sync/domains/state/storage';
import type { WorkspaceAction, WorkspaceTab, WorkspaceState } from './workspaceState';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { randomUUID } from '@/platform/randomUUID';
import { LocalSettingsPersistenceError } from '@/sync/domains/state/settingsPersistence';
import { reconcileWorkspaceSyncedTabs, type SharedWorkspaceTabs } from './workspaceSyncedTabs';
import {
    readScopedWorkspaceLayout, workspaceLayoutScopeKey, writeScopedWorkspaceLayout,
} from './workspacePersistence';

const WINDOW_ID_KEY = 'happier.workspace.windowIdV1';

function readOrCreateWindowId(): string | null {
    if (Platform.OS !== 'web') return 'main';
    if (typeof window === 'undefined') return null;
    try {
        const existing = window.sessionStorage.getItem(WINDOW_ID_KEY);
        if (existing) return existing;
        const next = globalThis.crypto?.randomUUID?.();
        if (!next) return null;
        window.sessionStorage.setItem(WINDOW_ID_KEY, next);
        return next;
    } catch {
        return null;
    }
}

export function useWorkspaceState(input: Readonly<{
    initialTab: WorkspaceTab;
    windowId?: string;
    admitState?: (state: WorkspaceState, retainedState?: WorkspaceState) => WorkspaceState;
}>): Readonly<{
    state: WorkspaceState;
    dispatch: (action: WorkspaceAction) => void;
    getState: () => WorkspaceState;
    restoreAction: (action: WorkspaceAction) => void;
    isRestored: boolean;
    isReady: boolean;
    windowId: string | null;
    applySharedRecord: (record: SharedWorkspaceTabs) => void;
}> {
    const scope = useActiveServerAccountScope();
    const isDataReady = useIsDataReady();
    const layouts = useLocalSetting('workspaceLayoutV1');
    const [generatedWindowId] = React.useState(readOrCreateWindowId);
    const windowId = input.windowId ?? generatedWindowId;
    const scopeKey = scope && windowId
        ? workspaceLayoutScopeKey({ serverId: scope.serverId, accountId: scope.accountId, windowId })
        : null;
    const canRestore = isDataReady && scopeKey !== null;
    const currentScopeRef = React.useRef(scopeKey);
    currentScopeRef.current = scopeKey;
    const fallbackState = React.useMemo(() => createWorkspaceState(input.initialTab), [input.initialTab]);
    const [storedState, setState] = React.useState<WorkspaceState>(() => {
        const restored = canRestore && scopeKey ? readScopedWorkspaceLayout(layouts, scopeKey) ?? fallbackState : fallbackState;
        return input.admitState?.(restored) ?? restored;
    });
    const state = React.useMemo(() => input.admitState?.(storedState) ?? storedState, [input.admitState, storedState]);
    // Admission replaces the canonical state before children commit; it never saves a layout.
    if (state !== storedState) setState(state);
    const stateRef = React.useRef(state);
    stateRef.current = state;
    const layoutsRef = React.useRef(layouts);
    layoutsRef.current = layouts;
    const restoredScopeRef = React.useRef<string | null>(canRestore ? scopeKey : null);
    // Core readiness admits the first restoration. Once that scope is restored,
    // a pending sync publication must not replace its retained destinations with
    // the initial preview and unmount editors whose handoff handles were consumed.
    // A different or unavailable Account/window still withdraws the old layout.
    const isRestored = scopeKey !== null && restoredScopeRef.current === scopeKey;
    const isReady = canRestore && isRestored;

    React.useEffect(() => {
        if (!canRestore || !scopeKey || restoredScopeRef.current === scopeKey) return;
        restoredScopeRef.current = scopeKey;
        const restored = readScopedWorkspaceLayout(layoutsRef.current, scopeKey) ?? createWorkspaceState(input.initialTab);
        const admitted = input.admitState?.(restored) ?? restored;
        stateRef.current = admitted;
        setState(admitted);
    }, [canRestore, input.admitState, input.initialTab, scopeKey]);

    const update = React.useCallback((next: WorkspaceState, retainedState?: WorkspaceState) => {
        if (!isReady || !scopeKey || currentScopeRef.current !== scopeKey) return null;
        next = input.admitState?.(next, retainedState) ?? next;
        if (next === stateRef.current) return null;
        stateRef.current = next;
        setState(next);
        return next;
    }, [input.admitState, isReady, scopeKey]);

    const dispatch = React.useCallback((action: WorkspaceAction) => {
        if (!isReady || currentScopeRef.current !== scopeKey) return;
        const next = update(reduceWorkspaceState(stateRef.current, action));
        if (!next || !scopeKey) return;
        const nextLayouts = writeScopedWorkspaceLayout(layoutsRef.current, scopeKey, next);
        layoutsRef.current = nextLayouts;
        try {
            getStorage().getState().applyLocalSettings({ workspaceLayoutV1: nextLayouts }, { source: 'ui' });
        } catch (error) {
            if (!(error instanceof LocalSettingsPersistenceError)) throw error;
            // Navigation already belongs to the live owner. A refused restoration snapshot must
            // not tear down the shell; the next explicit intent can persist the latest layout.
            console.warn('[workspace] Layout persistence failed; keeping the current workspace in memory.');
        }
    }, [isReady, update, scopeKey]);
    const restoreAction = React.useCallback((action: WorkspaceAction) => {
        update(reduceWorkspaceState(stateRef.current, action));
    }, [update]);
    const applySharedRecord = React.useCallback((record: SharedWorkspaceTabs) => {
        if (!isReady || currentScopeRef.current !== scopeKey) return;
        const retainedState = stateRef.current;
        update(reconcileWorkspaceSyncedTabs(retainedState, record, randomUUID), retainedState);
    }, [isReady, update, scopeKey]);

    const getState = React.useCallback(() => isRestored ? stateRef.current : fallbackState, [fallbackState, isRestored]);
    return { state: isRestored ? state : fallbackState, dispatch, restoreAction, getState, isRestored, isReady, windowId, applySharedRecord };
}
