import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import { buildReviewUnits, buildScmFileReviewUnits, buildScmReviewScopeId, type ReviewUnit } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { formatHunk } from '@happier-dev/protocol/diff/hunks';
import { useScmReviewedMarks, type ScmReviewedMarks } from '@/components/sessions/files/comparison/useScmReviewedMarks';
import type { DiffHunkAction, DiffHunkInfo, DiffHunkReviewState, DiffViewerHunks } from '@/components/ui/code/diff/diffViewerTypes';
import type { ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';
import { buildHunkReviewSummary, moveHunkReviewCursor, orderHunkReviewFiles, resolveHunkReviewUnit, type HunkReviewCursor, type HunkReviewFile } from './hunkReviewModel';

export type HunkReviewSource = Readonly<{ kind: 'captured'; comparison: ScmComparison }>
    | Readonly<{ kind: 'live'; root: string }>;
export type HunkReviewActionTarget = Readonly<{
    path: string;
    changeKey: string;
    expectedHash?: string;
    source: HunkReviewSource;
    unit: ReviewUnit;
}>;

/** The same keyed review actions serve a diff row and a tracked editor marker. */
export type HunkReviewChangeActions<DraftResult = never> = Readonly<{
    state: DiffHunkReviewState;
    keep: () => void;
    discard?: () => Promise<void | DraftResult>;
    ask?: () => void;
    copy: () => void;
    disabledReason: (action: DiffHunkAction) => string | null;
}>;

export type HunkReviewControllerParams = Readonly<{
    enabled?: boolean;
    source: HunkReviewSource;
    path: string;
    unifiedDiff: string;
    contentHash?: string | null;
    host: ScmDiffSummaryHost | null;
    serverId: string | null;
    /** A parent comparison reuses its one Account observer across rendered files. */
    marks?: ScmReviewedMarks;
    /** The live comparison's currently loaded files, when reviewing several files. */
    liveFiles?: readonly Readonly<{ path: string; unifiedDiff: string; generated?: boolean; lockfile?: boolean; pending?: boolean }>[];
    onNavigate?: (cursor: HunkReviewCursor) => void;
    onDiscard?: (target: HunkReviewActionTarget) => void | Promise<void>;
    onAsk?: (target: HunkReviewActionTarget) => void | Promise<void>;
    onOutOfDate?: () => void;
    discardDisabledReason?: string | null;
    undo?: () => void;
    onReviewAction?: () => void;
}>;

/** Review navigation, content identity and Keep share one owner on all reading surfaces. */
export function useHunkReviewController(params: HunkReviewControllerParams) {
    const captured = params.source.kind === 'captured' ? params.source.comparison : null;
    const unitsByPath = React.useMemo(() => {
        const result = new Map<string, readonly ReviewUnit[]>();
        if (captured) {
            for (const file of captured.inventory.files) result.set(file.path, buildScmFileReviewUnits(file.path === params.path
                ? { ...file, evidence: { state: 'available', unifiedDiff: params.unifiedDiff } } : file));
        } else {
            for (const file of params.liveFiles ?? []) result.set(file.path, buildReviewUnits(file.path, undefined,
                file.path === params.path ? params.unifiedDiff : file.unifiedDiff));
            if (!result.has(params.path)) result.set(params.path, buildReviewUnits(params.path, undefined, params.unifiedDiff));
        }
        return result;
    }, [captured, params.liveFiles, params.path, params.unifiedDiff]);
    const units = unitsByPath.get(params.path) ?? [];
    const files = React.useMemo<readonly HunkReviewFile[]>(() => {
        if (captured) return captured.inventory.files.map(file => ({ path: file.path,
            keys: (unitsByPath.get(file.path) ?? []).map(unit => unit.key),
            generated: file.generated, lockfile: file.lockfile }));
        if (params.liveFiles) return params.liveFiles.map(file => ({ ...file,
            keys: (unitsByPath.get(file.path) ?? []).map(unit => unit.key) }));
        return [{ path: params.path, keys: units.map(unit => unit.key) }];
    }, [captured, params.liveFiles, params.path, units, unitsByPath]);
    const liveSource = React.useMemo(() => params.source.kind === 'live' ? {
        repositoryRootPath: params.source.root, source: { kind: 'workingTree' as const }, changeKeys: files.flatMap(file => file.keys),
    } : undefined, [params.source.kind, params.source.kind === 'live' ? params.source.root : null, files]);
    const ownedMarks = useScmReviewedMarks({ comparison: params.marks || params.enabled === false ? null : captured,
        source: params.marks || params.enabled === false ? undefined : liveSource, host: params.host, serverId: params.serverId });
    const marks = params.marks ?? ownedMarks;
    const scopeId = buildScmReviewScopeId(params.source.kind === 'captured'
        ? { repositoryRootPath: params.source.comparison.repository.rootPath, source: params.source.comparison.source }
        : { repositoryRootPath: params.source.root, source: { kind: 'workingTree' } });
    const marked = React.useMemo(() => new Set(marks.record?.reviewedChangeKeys ?? []), [marks.record]);
    const [selection, setSelection] = React.useState<HunkReviewCursor | null>(null);
    // The change the page last moved to (navigation, Keep advance); `reading` once the reader's own scroll
    // chose the current change, so the page never jumps under the reader and the next move always lands.
    const [revealed, setRevealed] = React.useState<HunkReviewCursor | 'reading' | null>(null);
    const [table, setTable] = React.useState<readonly DiffHunkInfo[]>([]);
    const [discardingKey, setDiscardingKey] = React.useState<string | null>(null);
    const currentKey = selection?.path === params.path && units.some(unit => unit.key === selection.key)
        ? selection.key : units[0]?.key ?? null;
    const cursor = files.some(file => file.path === params.path) ? { path: params.path, key: currentKey } : null;
    const latest = React.useRef({ params, unitsByPath, marks, marked, files, cursor, scopeId });
    latest.current = { params, unitsByPath, marks, marked, files, cursor, scopeId };
    const onHunks = React.useCallback((next: readonly DiffHunkInfo[]) => {
        setTable(previous => previous.length === next.length && previous.every((hunk, index) =>
            hunk.key === next[index]?.key && hunk.firstChangeLineId === next[index]?.firstChangeLineId) ? previous : next);
    }, []);
    const moveTo = (next: HunkReviewCursor) => {
        setSelection(next);
        setRevealed(next);
        params.onNavigate?.(next);
    };
    const navigate = (direction: 1 | -1, fileOnly = false) => {
        const next = moveHunkReviewCursor(files, cursor, direction, marked, fileOnly);
        if (next) moveTo(next);
    };
    const findUnit = (key: string, path = params.path) => resolveHunkReviewUnit({ key, renderedScopeId: scopeId,
            currentScopeId: latest.current.scopeId, units: latest.current.unitsByPath.get(path) ?? [] });
    const resolve = (key: string, path = params.path) => {
        const unit = findUnit(key, path);
        if (!unit) { params.onOutOfDate?.(); return null; }
        return unit;
    };
    const keep = (key: string, path = params.path) => {
        const unit = resolve(key, path);
        if (!unit || latest.current.marks.unavailableReason) return;
        params.onReviewAction?.();
        marks.setReviewedKeys([unit.key], !latest.current.marked.has(unit.key));
    };
    // The handler retains the hash that accompanied its rendered row. Current key membership
    // is resolved at invocation; the canonical Discard owner guards the displayed bytes.
    const displayedHash = params.contentHash ?? null;
    const target = (key: string, path: string): HunkReviewActionTarget | null => {
        const unit = resolve(key, path);
        return unit ? { path, changeKey: key, ...(path === params.path && displayedHash ? { expectedHash: displayedHash } : {}),
            source: params.source, unit } : null;
    };
    const discard = async (key: string, path = params.path) => {
        const current = target(key, path);
        if (!current || latest.current.params.discardDisabledReason || !params.onDiscard) return;
        params.onReviewAction?.();
        setDiscardingKey(key);
        try { await params.onDiscard(current); }
        finally { setDiscardingKey(null); }
    };
    const ask = (key: string, path = params.path) => {
        const current = target(key, path);
        if (current) void params.onAsk?.(current);
    };
    const copy = (key: string, path: string) => {
        const unit = resolve(key, path);
        if (unit) void Clipboard.setStringAsync(formatHunk(unit.hunk));
    };
    const summary = React.useMemo(() => buildHunkReviewSummary(files, marked), [files, marked]);
    const ordered = React.useMemo(() => orderHunkReviewFiles(files), [files]);
    const fileIndex = ordered.findIndex(file => file.path === params.path);
    const numberOffset = ordered.slice(0, Math.max(0, fileIndex)).reduce((sum, file) => sum + file.keys.length, 0);
    const currentIndex = currentKey ? units.findIndex(unit => unit.key === currentKey) : -1;
    const revealKey = revealed === 'reading' ? null
        : revealed?.path === params.path && units.some(unit => unit.key === revealed.key) ? revealed.key : units[0]?.key ?? null;
    const nextFile = moveHunkReviewCursor(files, cursor, 1, marked, true);
    const stateOfKey = (key: string): DiffHunkReviewState => discardingKey === key ? 'discarding' : marked.has(key) ? 'kept' : 'open';
    const disabledReason = (action: DiffHunkAction) => action === 'keep' ? marks.unavailableReason
        : action === 'discard' ? params.discardDisabledReason ?? null : null;
    const changeActionsForKey = <DraftResult = never,>(key: string, options?: Readonly<{
        /** Dirty Discard is an editor transaction, so Machine reachability does not disable it. */
        discardInDraft?: () => Promise<DraftResult>;
    }>): HunkReviewChangeActions<DraftResult> | null => {
        // This reader runs while the peek renders; refresh only from an attempted stale action.
        if (!findUnit(key)) return null;
        const discardInDraft = options?.discardInDraft;
        return {
            state: stateOfKey(key), keep: () => keep(key), copy: () => copy(key, params.path),
            ...(params.onAsk ? { ask: () => ask(key) } : {}),
            disabledReason: action => action === 'discard' && discardInDraft ? null : disabledReason(action),
            ...(discardInDraft ? { discard: async () => {
                if (!resolve(key)) return;
                params.onReviewAction?.();
                setDiscardingKey(key);
                try { return await discardInDraft(); }
                finally { setDiscardingKey(null); }
            } } : params.onDiscard ? { discard: () => discard(key) } : {}),
        };
    };
    const hunksForPath = (path: string): DiffViewerHunks => {
        const index = ordered.findIndex(file => file.path === path);
        const offset = ordered.slice(0, Math.max(0, index)).reduce((sum, file) => sum + file.keys.length, 0);
        return {
        ...(path === params.path ? { onHunks } : {}),
        currentIndex: path === params.path && currentIndex >= 0 ? currentIndex : null, numberOffset: offset, numberTotal: summary.total,
        stateOf: hunk => stateOfKey(hunk.key),
        disabledReason: (_hunk, action) => disabledReason(action),
        actions: { keep: hunk => keep(hunk.key, path), copy: hunk => copy(hunk.key, path),
            ...(params.onDiscard ? { discard: (hunk: DiffHunkInfo) => { void discard(hunk.key, path); } } : {}),
            ...(params.onAsk ? { ask: (hunk: DiffHunkInfo) => ask(hunk.key, path) } : {}) },
        };
    };
    const hunks = hunksForPath(params.path);
    return {
        hunks, hunksForPath, changeActionsForKey, reviewUnitsForPath: (path: string) => unitsByPath.get(path) ?? [],
        reviewUnits: units, cursor, currentIndex, currentHunk: table.find(hunk => hunk.key === currentKey) ?? null,
        /** Where the page should be scrolled: the change last moved to, never one the reader scrolled onto. */
        revealHunk: table.find(hunk => hunk.key === revealKey) ?? null,
        /** Phone: the change crossing the reading line becomes current (P5 §3.11) without scrolling the page. */
        followReadingLine: (key: string) => {
            if (key === currentKey || !units.some(unit => unit.key === key)) return;
            setSelection({ path: params.path, key });
            setRevealed('reading');
        },
        strip: { ...summary, currentOrdinal: currentIndex < 0 ? 0 : numberOffset + currentIndex + 1,
            canKeepAll: !marks.unavailableReason && units.some(unit => !marked.has(unit.key)),
            nextFile: nextFile?.path !== params.path ? nextFile?.path ?? null : null,
            fileComplete: units.length > 0 && units.every(unit => marked.has(unit.key)) },
        next: () => navigate(1), previous: () => navigate(-1), nextFile: () => navigate(1, true), previousFile: () => navigate(-1, true),
        keepCurrent: () => { if (currentKey) keep(currentKey); },
        /** The phone bar's Keep: mark the current change, then glide to the next open change in this file. */
        keepCurrentAndAdvance: () => {
            if (!currentKey || latest.current.marks.unavailableReason) return;
            const keeping = !marked.has(currentKey);
            keep(currentKey);
            if (!keeping) return;
            const at = units.findIndex(unit => unit.key === currentKey);
            const open = [...units.slice(at + 1), ...units.slice(0, Math.max(0, at))].find(unit => !marked.has(unit.key));
            if (open) moveTo({ path: params.path, key: open.key });
        },
        discardCurrent: params.onDiscard ? () => { if (currentKey) void discard(currentKey); } : undefined,
        askCurrent: params.onAsk ? () => { if (currentKey) ask(currentKey); } : undefined,
        keepAll: () => { if (!marks.unavailableReason && units.length > 0) {
            params.onReviewAction?.(); marks.setReviewedKeys(units.map(unit => unit.key), true);
        } },
        reset: marks.clear, undo: params.undo,
    };
}
