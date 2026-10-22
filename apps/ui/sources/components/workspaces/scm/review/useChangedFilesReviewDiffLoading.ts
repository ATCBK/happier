import * as React from 'react';

import type { ScmComparisonFile, ScmDiffArea } from '@happier-dev/protocol';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmDiffCache } from '@/scm/diffCache/scmDiffCache';
import { fetchSessionUnifiedDiffForPath } from '@/scm/diff/fetchSessionUnifiedDiffForPath';
import type { ScmReviewUnifiedDiffFetcher } from '@/components/workspaces/scm/review/scmReviewDiffFetcher';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';

import {
    createChangedFilesReviewDiffStateSource,
    type ChangedFilesReviewDiffStateSource,
} from '@/components/workspaces/scm/review/ChangedFilesReviewDiffStore';

function resolveReviewDiffPathsToEnsure(input: Readonly<{
    requestedPaths: readonly string[] | null;
    tooLarge: boolean;
    selectedPath: string;
    reviewFiles: readonly ScmFileStatus[];
}>): string[] {
    const pathsToEnsure: string[] = [];
    if (input.requestedPaths !== null) {
        pathsToEnsure.push(...input.requestedPaths);
    } else if (input.tooLarge) {
        const path = input.selectedPath || input.reviewFiles[0]?.fullPath;
        if (path) pathsToEnsure.push(path);
    } else {
        const anchor = input.selectedPath || input.reviewFiles[0]?.fullPath;
        if (anchor) pathsToEnsure.push(anchor);
    }

    const seen = new Set<string>();
    return pathsToEnsure.filter((path) => {
        if (seen.has(path)) return false;
        seen.add(path);
        return true;
    });
}

export function useChangedFilesReviewDiffLoading(input: {
    sessionId: string;
    reviewScopeKey?: string;
    isRepo: boolean;
    reviewFiles: readonly ScmFileStatus[];
    diffArea: ScmDiffArea;
    requestedPaths?: readonly string[];
    snapshotSignature?: string | null;
    diffCache?: ScmDiffCache | null;
    tooLarge: boolean;
    selectedPath: string;
    maxConcurrency?: number;
    minRefetchMs?: number;
    refreshToken?: number;
    providerDiffByPath?: ReadonlyMap<string, string | null> | null;
    fetchUnifiedDiffForPath?: ScmReviewUnifiedDiffFetcher;
    findContext?: boolean;
    workspaceScope?: WorkspaceScopeBase | null;
    comparisonFiles?: readonly ScmComparisonFile[];
    normalizeError: (input: unknown) => string;
    fallbackError: string;
}) {
    const {
        sessionId,
        reviewScopeKey = sessionId,
        isRepo,
        reviewFiles,
        diffArea,
        requestedPaths,
        snapshotSignature,
        diffCache,
        tooLarge,
        selectedPath,
        maxConcurrency,
        normalizeError,
        fallbackError,
        minRefetchMs,
        refreshToken,
        providerDiffByPath,
        fetchUnifiedDiffForPath,
    } = input;

    const requestedPathsNormalized = React.useMemo<readonly string[] | null>(() => {
        if (!Array.isArray(requestedPaths)) return null;
        const out: string[] = [];
        for (const p of requestedPaths) {
            if (typeof p !== 'string') continue;
            const trimmed = p.trim();
            if (trimmed.length === 0) continue;
            out.push(trimmed);
        }
        return out;
    }, [requestedPaths]);

    const requestedPathsKey = React.useMemo(() => {
        return JSON.stringify(requestedPathsNormalized);
    }, [requestedPathsNormalized]);

    const requestedPathsNormalizedRef = React.useRef<readonly string[] | null>(null);
    requestedPathsNormalizedRef.current = requestedPathsNormalized;

    const diffStateSourceRef = React.useRef<ChangedFilesReviewDiffStateSource | null>(null);
    if (!diffStateSourceRef.current) {
        diffStateSourceRef.current = createChangedFilesReviewDiffStateSource();
    }
    const diffStateSource = diffStateSourceRef.current;
    const findContext = input.findContext === true;
    const { serverId, machineId, rootPath } = input.workspaceScope ?? {};
    const comparisonFiles = input.comparisonFiles;

    React.useEffect(() => {
        if (findContext) return;
        for (const [path, state] of diffStateSource.getSnapshot()) {
            if (!state.context) continue;
            const { context: _context, ...withoutContext } = state;
            diffStateSource.setDiffState(path, withoutContext);
        }
    }, [diffStateSource, findContext]);

    const lastFetchAtMsByPathRef = React.useRef<Record<string, number>>({});
    const inFlightPathsRef = React.useRef<Set<string>>(new Set());
    const fileStatusByPath = React.useMemo(() => {
        const map = new Map<string, ScmFileStatus>();
        for (const file of reviewFiles) {
            if (!file?.fullPath) continue;
            map.set(file.fullPath, file);
        }
        return map;
    }, [reviewFiles]);

    const minRefetchMsResolved = React.useMemo<null | number>(() => {
        if (minRefetchMs === null || minRefetchMs === undefined) return null;
        const raw = typeof minRefetchMs === 'number' && Number.isFinite(minRefetchMs) ? minRefetchMs : 0;
        return Math.max(0, raw);
    }, [minRefetchMs]);

    const hasScopedDiffs = providerDiffByPath != null;
    React.useEffect(() => {
        diffStateSource.reset();
        lastFetchAtMsByPathRef.current = {};
        inFlightPathsRef.current = new Set();
    }, [diffArea, hasScopedDiffs, reviewScopeKey]);

    React.useEffect(() => {
        inFlightPathsRef.current = new Set();
        // Force a revalidate on the next effect run without clearing already-loaded diffs.
        // This is used for manual refresh, and for snapshot signature changes from SCM refresh.
        lastFetchAtMsByPathRef.current = {};
    }, [diffArea, refreshToken, reviewScopeKey, snapshotSignature]);

    React.useEffect(() => {
        diffStateSource.prune(new Set(fileStatusByPath.keys()), inFlightPathsRef.current);
    }, [fileStatusByPath]);

    React.useEffect(() => {
        if (!providerDiffByPath || providerDiffByPath.size === 0) return;
        const pathsToEnsure = resolveReviewDiffPathsToEnsure({
            requestedPaths: requestedPathsNormalizedRef.current,
            tooLarge,
            selectedPath,
            reviewFiles,
        });
        for (const path of pathsToEnsure) {
            const providerDiff = providerDiffByPath.get(path);
            if (providerDiff === undefined) continue;
            diffStateSource.setDiffState(path, providerDiff === null ? {
                status: 'error',
                diff: '',
                error: fallbackError,
            } : {
                status: 'loaded',
                diff: providerDiff,
                error: null,
            });
            lastFetchAtMsByPathRef.current[path] = Date.now();
        }
    }, [diffStateSource, fallbackError, providerDiffByPath, requestedPathsKey, reviewFiles, selectedPath, tooLarge]);

    React.useEffect(() => {
        if (!sessionId && !fetchUnifiedDiffForPath) return;
        if (!isRepo) return;
        if (reviewFiles.length === 0) return;

        let cancelled = false;
        const contextRead = new AbortController();
        const inFlightPaths = new Set<string>();
        inFlightPathsRef.current = inFlightPaths;

        const ensureFindContext = async (path: string) => {
            const state = diffStateSource.getDiffState(path);
            if (!findContext || state.status !== 'loaded' || (state.context && state.context.status !== 'loading') || !state.diff) return;
            const file = fileStatusByPath.get(path);
            if (file?.isBinary) return;
            const captured = comparisonFiles?.find(file => file.path === path);
            const scope = machineId && rootPath ? input.workspaceScope : resolveWorkspaceTargetForSession(sessionId);
            diffStateSource.setDiffState(path, { ...state, context: { status: 'loading' } });
            let baseText: string | null = null;
            try {
                if (file?.status === 'added' || file?.status === 'untracked') baseText = '';
                else if (scope && (!hasScopedDiffs || captured?.beforeBlobId)) {
                    const { fetchWorkspaceFileAtRevision } = await import('@/scm/files/fetchWorkspaceFileAtRevision');
                    const read = await fetchWorkspaceFileAtRevision({ scope, path: captured?.previousPath ?? path,
                        selector: captured?.beforeBlobId ? { blobId: captured.beforeBlobId } : { side: 'before', area: diffArea },
                        signal: contextRead.signal });
                    if (read.success && !read.bytes.includes(0)) baseText = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
                }
            } catch { /* The patch remains searchable; unreadable context is partial coverage. */ }
            if (cancelled) return;
            diffStateSource.updateDiffState(path, current => current.diff !== state.diff ? current : { ...current,
                context: baseText === null ? { status: 'unavailable' } : { status: 'loaded', baseText } });
        };

        const loadDiff = async (path: string) => {
            const existing = diffStateSource.getDiffState(path);
            const nowMs = Date.now();
            if (existing?.status === 'loaded' || existing?.status === 'error') {
                const lastFetchAtMs = lastFetchAtMsByPathRef.current[path] ?? 0;
                if (lastFetchAtMs > 0) {
                    // Default behavior is stale-while-revalidate: do not refetch already-loaded diffs
                    // unless explicitly requested (refreshToken/snapshotSignature clears lastFetchAt).
                    // A snapshot's lifetime is owned by SCM invalidation, not render
                    // timing. Equal status counts alone are not its signature.
                    if (snapshotSignature || minRefetchMsResolved === null) {
                        await ensureFindContext(path);
                        return;
                    }
                    if (minRefetchMsResolved > 0 && (nowMs - lastFetchAtMs) < minRefetchMsResolved) {
                        await ensureFindContext(path);
                        return;
                    }
                }
            }
            if (inFlightPaths.has(path)) {
                return;
            }
            const providerDiff = providerDiffByPath?.get(path);
            if (providerDiff !== undefined) {
                diffStateSource.setDiffState(path, providerDiff === null ? {
                    status: 'error',
                    diff: '',
                    error: fallbackError,
                } : {
                    status: 'loaded',
                    diff: providerDiff,
                    error: null,
                });
                lastFetchAtMsByPathRef.current[path] = Date.now();
                await ensureFindContext(path);
                return;
            }
            inFlightPaths.add(path);

            diffStateSource.updateDiffState(path, (prev) => {
                // Stale-while-revalidate: keep already-loaded diffs visible while we refresh in the background.
                if (prev?.status === 'loaded' && prev.diff) {
                    return prev;
                }
                return { status: 'loading', diff: '', error: null };
            });
            try {
                const file = fileStatusByPath.get(path) ?? null;
                const response = fetchUnifiedDiffForPath
                    ? await fetchUnifiedDiffForPath({
                        diffArea,
                        path,
                        file,
                        normalizeError,
                        fallbackError,
                        snapshotSignature,
                        diffCache,
                    })
                    : await fetchSessionUnifiedDiffForPath({
                        sessionId,
                        diffArea,
                        path,
                        file,
                        normalizeError,
                        fallbackError,
                        snapshotSignature,
                        diffCache,
                    });
                if (cancelled) return;
                lastFetchAtMsByPathRef.current[path] = Date.now();
                if (!response.success) {
                    diffStateSource.updateDiffState(path, (prev) => {
                        if (prev?.status === 'loaded' && prev.diff) {
                            return prev;
                        }
                        return { status: 'error', diff: '', error: response.error };
                    });
                    return;
                }

                diffStateSource.setDiffState(path, { status: 'loaded', diff: response.diff ?? '', error: null,
                    ...('emptyFile' in response && response.emptyFile ? { emptyFile: true } : {}) });
                await ensureFindContext(path);

            } catch (err) {
                if (cancelled) return;
                const normalized = normalizeError(err);
                diffStateSource.updateDiffState(path, (prev) => {
                    if (prev?.status === 'loaded' && prev.diff) {
                        return prev;
                    }
                    return {
                        status: 'error',
                        diff: '',
                        error: (typeof normalized === 'string' && normalized.trim()) ? normalized : fallbackError,
                    };
                });
                lastFetchAtMsByPathRef.current[path] = Date.now();
            } finally {
                inFlightPaths.delete(path);
            }
        };

        const run = async () => {
            const uniquePaths = resolveReviewDiffPathsToEnsure({
                requestedPaths: requestedPathsNormalizedRef.current,
                tooLarge,
                selectedPath,
                reviewFiles,
            });

            const resolvedConcurrency = (() => {
                const raw = typeof maxConcurrency === 'number' && Number.isFinite(maxConcurrency) ? maxConcurrency : 1;
                return Math.max(1, Math.floor(raw));
            })();

            const queue = uniquePaths.slice();
            const workerCount = Math.min(resolvedConcurrency, queue.length);
            const workers = Array.from({ length: workerCount }, async () => {
                while (!cancelled) {
                    const next = queue.shift();
                    if (!next) return;
                    await loadDiff(next);
                }
            });
            await Promise.all(workers);
        };

        run();
        return () => {
            cancelled = true;
            contextRead.abort();
        };
    }, [
        diffArea,
        diffCache,
        fallbackError,
        fileStatusByPath,
        fetchUnifiedDiffForPath,
        isRepo,
        minRefetchMsResolved,
        normalizeError,
        refreshToken,
        requestedPathsKey,
        reviewFiles,
        selectedPath,
        sessionId,
        reviewScopeKey,
        snapshotSignature,
        tooLarge,
        providerDiffByPath,
        findContext, serverId, machineId, rootPath, comparisonFiles,
    ]);

    return {
        diffStateSource,
    };
}
