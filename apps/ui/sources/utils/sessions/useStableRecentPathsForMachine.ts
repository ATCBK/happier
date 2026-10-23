import * as React from 'react';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';

import { getRecentPathsForMachine } from './recentPaths';

type RecentMachinePath = Readonly<{
    machineId: string;
    path: string;
}>;

type RecentPathSessionSource =
    | Pick<Session, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>
    | Pick<SessionListRenderableSession, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>;

type RecentPathSessions = ReadonlyArray<RecentPathSessionSource | string> | null | undefined;
export type RecentPathSessionsInput = RecentPathSessions | (() => RecentPathSessions);

function buildCacheKey(input: Readonly<{
    cacheScopeKey?: string | null;
    machineId: string;
}>): string {
    return `${input.cacheScopeKey ?? ''}\u0000${input.machineId}`;
}

function mergeCurrentWithCachedPaths(
    currentPaths: ReadonlyArray<string>,
    cachedPaths: ReadonlyArray<string>,
): string[] {
    const seen = new Set<string>();
    const merged: string[] = [];

    for (const path of [...currentPaths, ...cachedPaths]) {
        if (seen.has(path)) continue;
        seen.add(path);
        merged.push(path);
    }

    return merged;
}

export function useStableRecentPathsForMachine(params: Readonly<{
    machineId: string | null | undefined;
    recentMachinePaths: ReadonlyArray<RecentMachinePath>;
    sessions: RecentPathSessionsInput;
    cacheScopeKey?: string | null;
}>): ReadonlyArray<string> {
    const resolveRecentPathsForMachine = useStableRecentPathsResolver({
        recentMachinePaths: params.recentMachinePaths,
        sessions: params.sessions,
        cacheScopeKey: params.cacheScopeKey,
    });

    return React.useMemo(() => {
        return resolveRecentPathsForMachine(params.machineId);
    }, [params.machineId, resolveRecentPathsForMachine]);
}

export function useStableRecentPathsResolver(params: Readonly<{
    recentMachinePaths: ReadonlyArray<RecentMachinePath>;
    sessions: RecentPathSessionsInput;
    cacheScopeKey?: string | null;
}>): (machineId: string | null | undefined) => ReadonlyArray<string> {
    const pathsByScopeAndMachineRef = React.useRef<Map<string, string[]>>(new Map());

    return React.useCallback((rawMachineId: string | null | undefined) => {
        const machineId = typeof rawMachineId === 'string' ? rawMachineId.trim() : '';
        if (!machineId) return [];

        const sessions = typeof params.sessions === 'function' ? params.sessions() : params.sessions;
        const currentPaths = getRecentPathsForMachine({
            machineId,
            recentMachinePaths: params.recentMachinePaths,
            sessions,
        });
        const cacheKey = buildCacheKey({
            cacheScopeKey: params.cacheScopeKey,
            machineId,
        });

        if (sessions === null || sessions === undefined) {
            const cachedPaths = pathsByScopeAndMachineRef.current.get(cacheKey);
            return cachedPaths ? mergeCurrentWithCachedPaths(currentPaths, cachedPaths) : currentPaths;
        }

        pathsByScopeAndMachineRef.current.set(cacheKey, currentPaths);
        return currentPaths;
    }, [params.cacheScopeKey, params.recentMachinePaths, params.sessions]);
}
