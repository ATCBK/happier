import * as React from 'react';

import { useOptionalUniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { selectScmChangedFiles } from '@/scm/scmStatusFiles';
import { storage, useLocalSetting, useWorkspaceScmSnapshot, useWorkspaceScmTouchedPathsForSession } from '@/sync/domains/state/storage';
import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { selectRecentWorkspaceFiles, workspacePathToFileSearchItem } from '@/sync/domains/workspaces/files/recentWorkspaceFiles';
import { workspaceFileSearchCache } from '@/sync/domains/workspaces/files/workspaceFileSearch';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

const NO_PATHS: readonly string[] = [];

function projectQuickOpenRecentFiles(input: Readonly<{
    storedPaths: readonly string[];
    knownFiles: readonly FileSearchItem[] | null | undefined;
    deletedPaths: readonly string[];
    activeFilePath?: string | null;
}>): FileSearchItem[] {
    const deleted = new Set(input.deletedPaths);
    const paths = selectRecentWorkspaceFiles(input.storedPaths, input.knownFiles?.filter(file => file.fileType === 'file').map(file => file.fullPath) ?? null)
        .filter(path => !deleted.has(path));
    if (input.activeFilePath && paths.includes(input.activeFilePath)) {
        paths.splice(paths.indexOf(input.activeFilePath), 1);
        paths.unshift(input.activeFilePath);
    }
    return paths.map(workspacePathToFileSearchItem);
}

/** Demand-time read of the same Recent source, without mounting a picker subscription or issuing RPCs. */
export function readQuickOpenRecentFiles(scope: WorkspaceScopeBase | null): readonly FileSearchItem[] {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!scope || !lifetime || lifetime.scope.serverId !== scope.serverId || !lifetime.isCurrent()) return [];
    const key = tryBuildWorkspaceCacheKey(scope);
    if (!key) return [];
    const state = storage.getState();
    const snapshot = state.getWorkspaceScmSnapshot(scope);
    return projectQuickOpenRecentFiles({ storedPaths: state.localSettings.recentWorkspaceFilesV1[key] ?? NO_PATHS,
        knownFiles: workspaceFileSearchCache.readFiles(scope, lifetime),
        deletedPaths: snapshot?.entries.filter(entry => entry.kind === 'deleted').map(entry => entry.path) ?? NO_PATHS });
}

/** Device-local Recent and the canonical last SCM snapshot, shared by quick open and the empty editor column. */
type QuickOpenEmptyStateInput = Readonly<{
    scope: WorkspaceScopeBase | null;
    sessionId?: string | null;
    activeFilePath?: string | null;
    knownFiles?: readonly FileSearchItem[];
}>;

export function useQuickOpenFileSources(input: QuickOpenEmptyStateInput) {
    const stored = useLocalSetting('recentWorkspaceFilesV1');
    const snapshot = useWorkspaceScmSnapshot(input.scope);
    const touched = useWorkspaceScmTouchedPathsForSession(input.sessionId ?? null, input.scope?.serverId);
    const credentials = useServerCredentialAccountScopeBinding(input.scope?.serverId);
    const authorized = credentials.binding?.isCurrent() === true;
    const key = input.scope ? tryBuildWorkspaceCacheKey(input.scope) : null;
    const storedPaths = authorized && key ? stored[key] ?? NO_PATHS : NO_PATHS;
    const knownFiles = input.knownFiles ?? (input.scope && credentials.binding
        ? workspaceFileSearchCache.readFiles(input.scope, credentials.binding) : null);
    const recent = React.useMemo(() => {
        return projectQuickOpenRecentFiles({ storedPaths, knownFiles, activeFilePath: input.activeFilePath,
            deletedPaths: snapshot?.entries.filter(entry => entry.kind === 'deleted').map(entry => entry.path) ?? NO_PATHS });
    }, [input.activeFilePath, knownFiles, snapshot, storedPaths]);
    const changed = React.useMemo(() => {
        if (!authorized || !snapshot) return [];
        const files = selectScmChangedFiles(snapshot);
        if (!input.sessionId) return files;
        const paths = new Set(touched);
        return files.filter(file => paths.has(file.fullPath));
    }, [authorized, input.sessionId, snapshot, touched]);
    const defaultSelectedPath = recent[0]?.fullPath === input.activeFilePath
        ? recent[1]?.fullPath ?? changed.find(file => file.fullPath !== input.activeFilePath)?.fullPath ?? input.activeFilePath
        : recent[0]?.fullPath ?? changed[0]?.fullPath ?? null;
    return { recent, recentPaths: storedPaths, changed, defaultSelectedPath, accountId: credentials.binding?.accountId ?? null };
}

/**
 * Opens quick open (Universal Search, Files in this workspace) from a control that is not the keyboard
 * command: the empty editor column, the Files tree's Go to file field (with what was typed there).
 * Null where Search is not mounted.
 */
export function useQuickOpenFilesLauncher(input: Readonly<{ scope: WorkspaceScopeBase | null; sessionId?: string | null }>) {
    const runtime = useOptionalUniversalSearchRuntime();
    const accountId = useServerCredentialAccountScopeBinding(input.scope?.serverId).binding?.accountId ?? null;
    const scope = input.scope;
    const sessionId = input.sessionId ?? null;
    return React.useMemo(() => runtime ? (query?: string) => {
        runtime.open(query?.trim() ? query : undefined, scope ? { ...scope, accountId, sessionId } : undefined, { source: 'files' });
    } : null, [accountId, runtime, scope, sessionId]);
}

export function useQuickOpenEmptyState(input: QuickOpenEmptyStateInput) {
    const sources = useQuickOpenFileSources(input);
    const launch = useQuickOpenFilesLauncher(input);
    const openFiles = React.useCallback(() => { launch?.(); }, [launch]);
    return { ...sources, openFiles };
}
