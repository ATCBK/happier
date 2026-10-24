import * as React from 'react';

import { scmRepositoryService, snapshotToScmStatus } from '@/scm/scmRepositoryService';
import { storage, useWorkspaceScmSnapshot, useWorkspaceScmSnapshotError } from '@/sync/domains/state/storage';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { t } from '@/text';
import {
    normalizeWorkspaceScopeBase,
    type WorkspaceScopeBase,
} from '@/sync/domains/workspaces/workspaceScope';

export type WorkspaceScmSnapshotControllerError = Readonly<{
    message: string;
    errorCode: string | null;
}>;

export type UseWorkspaceScmSnapshotControllerResult = Readonly<{
    snapshot: ReturnType<typeof useWorkspaceScmSnapshot>;
    loading: boolean;
    error: WorkspaceScmSnapshotControllerError | null;
    refresh: () => Promise<void>;
}>;

function normalizeScope(input: WorkspaceScopeBase | null): WorkspaceScopeBase | null {
    if (!input) return null;
    return normalizeWorkspaceScopeBase({
        serverId: input.serverId,
        machineId: input.machineId,
        rootPath: input.rootPath,
    });
}

export function useWorkspaceScmSnapshotController(scope: WorkspaceScopeBase | null,
    options?: Readonly<{ refreshOnMount?: boolean }>): UseWorkspaceScmSnapshotControllerResult {
    const refreshOnMount = options?.refreshOnMount !== false;
    const normalizedScope = React.useMemo(() => normalizeScope(scope), [scope?.machineId, scope?.rootPath, scope?.serverId]);
    const snapshot = useWorkspaceScmSnapshot(normalizedScope);
    const snapshotError = useWorkspaceScmSnapshotError(normalizedScope);
    const presence = useMachinePresenceSummary(normalizedScope?.serverId, normalizedScope?.machineId);
    const unreachable = presence.reachability === 'unreachable';

    const [loading, setLoading] = React.useState(false);
    const error = React.useMemo<WorkspaceScmSnapshotControllerError | null>(() => {
        if (unreachable) return { message: t('errors.daemonUnavailableBody'), errorCode: 'machine_offline' };
        if (!snapshotError) return null;
        const code =
            typeof snapshotError === 'object'
            && snapshotError !== null
            && 'errorCode' in snapshotError
            && typeof (snapshotError as { errorCode?: unknown }).errorCode === 'string'
                ? ((snapshotError as { errorCode: string }).errorCode)
                : null;
        return {
            message: snapshotError.message,
            errorCode: code,
        };
    }, [unreachable, snapshotError?.message, (snapshotError as { errorCode?: unknown } | null | undefined)?.errorCode]);

    const refresh = React.useCallback(async () => {
        if (!normalizedScope || unreachable) return;
        setLoading(true);
        try {
            const next = await scmRepositoryService.fetchSnapshotForMachinePath({
                serverId: normalizedScope.serverId,
                machineId: normalizedScope.machineId,
                path: normalizedScope.rootPath,
            });

            const state = storage.getState();
            state.updateWorkspaceScmSnapshot(normalizedScope, next);
            state.updateWorkspaceScmSnapshotError(normalizedScope, null);
            state.updateWorkspaceScmStatus(
                normalizedScope,
                next ? snapshotToScmStatus(next) : null,
            );

            const activePaths = new Set<string>(
                next?.entries?.map((entry) => String(entry?.path ?? '')).filter(Boolean) ?? [],
            );
            state.pruneWorkspaceScmTouchedPaths(normalizedScope, activePaths);
            state.pruneWorkspaceScmCommitSelectionPaths(normalizedScope, activePaths);
            state.pruneWorkspaceScmCommitSelectionPatches(normalizedScope, activePaths);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to fetch source-control snapshot';
            const scmErrorCode =
                typeof err === 'object'
                && err !== null
                && 'scmErrorCode' in err
                && typeof (err as { scmErrorCode?: unknown }).scmErrorCode === 'string'
                    ? (err as { scmErrorCode: string }).scmErrorCode
                    : undefined;

            const state = storage.getState();
            state.updateWorkspaceScmSnapshotError(normalizedScope, {
                message,
                at: Date.now(),
                ...(scmErrorCode ? { errorCode: scmErrorCode } : {}),
            });
        } finally {
            setLoading(false);
        }
    }, [normalizedScope, unreachable]);

    const initKey = normalizedScope
        ? `${normalizedScope.serverId}:${normalizedScope.machineId}:${normalizedScope.rootPath}`
        : '';
    const didInitKeyRef = React.useRef<string>('');
    React.useEffect(() => {
        if (!refreshOnMount) return;
        if (unreachable) {
            didInitKeyRef.current = '';
            return;
        }
        if (!normalizedScope) return;
        if (didInitKeyRef.current === initKey) return;
        didInitKeyRef.current = initKey;
        void refresh();
    }, [initKey, normalizedScope, refresh, refreshOnMount, unreachable]);

    return {
        snapshot,
        loading: loading && !unreachable,
        error,
        refresh,
    };
}
