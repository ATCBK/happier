import * as React from 'react';

import { useUniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { selectScmChangedFiles } from '@/scm/scmStatusFiles';
import { useLocalSetting, useWorkspaceScmSnapshot, useWorkspaceScmTouchedPathsForSession } from '@/sync/domains/state/storage';
import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { selectRecentWorkspaceFiles, workspacePathToFileSearchItem } from '@/sync/domains/workspaces/files/recentWorkspaceFiles';
import { workspaceFileSearchCache } from '@/sync/domains/workspaces/files/workspaceFileSearch';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

const NO_PATHS: readonly string[] = [];

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
        const deleted = new Set(snapshot?.entries.filter(entry => entry.kind === 'deleted').map(entry => entry.path));
        const paths = selectRecentWorkspaceFiles(storedPaths, knownFiles?.filter(file => file.fileType === 'file').map(file => file.fullPath) ?? null)
            .filter(path => !deleted.has(path));
        if (input.activeFilePath && paths.includes(input.activeFilePath)) {
            paths.splice(paths.indexOf(input.activeFilePath), 1);
            paths.unshift(input.activeFilePath);
        }
        return paths.map(workspacePathToFileSearchItem);
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

export function useQuickOpenEmptyState(input: QuickOpenEmptyStateInput) {
    const runtime = useUniversalSearchRuntime();
    const sources = useQuickOpenFileSources(input);
    const openFiles = React.useCallback(() => {
        runtime.open(undefined, input.scope ? { ...input.scope,
            accountId: sources.accountId, sessionId: input.sessionId ?? null } : undefined, { source: 'files' });
    }, [input.scope, input.sessionId, runtime, sources.accountId]);
    return { ...sources, openFiles };
}
