import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { resolveWorkspaceTargetForSessionFromState, type WorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSessionFromState';
import { storage } from '@/sync/domains/state/storage';
import { useShallow } from 'zustand/react/shallow';
import type { StorageState } from '@/sync/store/types';

export function resolveWorkspaceScopeForSession(sessionId: string): WorkspaceScopeBase | null {
    return resolveWorkspaceTargetForSession(sessionId);
}

export function useWorkspaceScopeForSession(
    sessionId: string | null | undefined,
    serverId?: string | null,
): WorkspaceTargetForSession | null {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
    const selector = useShallow((state: StorageState): WorkspaceTargetForSession | null => {
        if (!normalizedSessionId) return null;
        return resolveWorkspaceTargetForSessionFromState({
            sessions: state.sessions,
            sessionListRowsByServerId: state.sessionListRowsByServerId,
            ordinarySessionListMembershipByServerId: state.ordinarySessionListMembershipByServerId,
            machines: state.machines,
            machineListByServerId: state.machineListByServerId,
            sessionListIndexByServerId: state.sessionListIndexByServerId,
            getProjectForSession: state.getProjectForSession,
            // A qualified caller names the Home; only an unqualified one may fall back to same-id
            // discovery, which cannot separate two Homes hosting one Session id.
        }, normalizedServerId ? { sessionId: normalizedSessionId, serverId: normalizedServerId } : normalizedSessionId);
    });
    const workspaceState = typeof storage === 'function'
        ? storage(selector)
        : (
            (storage as unknown as { getState?: () => StorageState }).getState
                ? selector((storage as unknown as { getState: () => StorageState }).getState())
                : null
        );
    return workspaceState;
}
