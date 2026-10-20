import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import { buildReviewUnits, buildScmFileReviewUnits, buildScmReviewScopeId, type ReviewUnit } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { formatHunk } from '@happier-dev/protocol/diff/hunks';
import { useScmReviewedMarks, type ScmReviewedMarks } from '@/components/sessions/files/comparison/useScmReviewedMarks';
import type { DiffHunkInfo, DiffViewerHunks } from '@/components/ui/code/diff/diffViewerTypes';
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

export type HunkReviewControllerParams = Readonly<{
    source: HunkReviewSource;
    path: string;
    unifiedDiff: string;
    contentHash?: string | null;
    host: ScmDiffSummaryHost | null;
    serverId: string | null;
    /** A parent comparison reuses its one Account observer across rendered files. */
    marks?: ScmReviewedMarks;
    /** The live comparison's currently loaded files, when reviewing several files. */
    liveFiles?: readonly Readonly<{ path: string; unifiedDiff: string; generated?: boolean; lockfile?: boolean }>[];
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
    const currentFile = captured?.inventory.files.find(file => file.path === params.path);
    const units = React.useMemo(() => currentFile
        ? buildScmFileReviewUnits({ ...currentFile, evidence: { state: 'available', unifiedDiff: params.unifiedDiff } })
        : buildReviewUnits(params.path, undefined, params.unifiedDiff), [currentFile, params.path, params.unifiedDiff]);
    const files = React.useMemo<readonly HunkReviewFile[]>(() => {
        if (captured) return captured.inventory.files.map(file => ({ path: file.path,
            keys: (file.path === params.path ? units : buildScmFileReviewUnits(file)).map(unit => unit.key),
            generated: file.generated, lockfile: file.lockfile }));
        if (params.liveFiles) return params.liveFiles.map(file => ({ ...file,
            keys: (file.path === params.path ? units : buildReviewUnits(file.path, undefined, file.unifiedDiff)).map(unit => unit.key) }));
        return [{ path: params.path, keys: units.map(unit => unit.key) }];
    }, [captured, params.liveFiles, params.path, units]);
    const liveSource = React.useMemo(() => params.source.kind === 'live' ? {
        repositoryRootPath: params.source.root, source: { kind: 'workingTree' as const }, changeKeys: files.flatMap(file => file.keys),
    } : undefined, [params.source.kind, params.source.kind === 'live' ? params.source.root : null, files]);
    const ownedMarks = useScmReviewedMarks({ comparison: params.marks ? null : captured,
        source: params.marks ? undefined : liveSource, host: params.host, serverId: params.serverId });
    const marks = params.marks ?? ownedMarks;
    const scopeId = buildScmReviewScopeId(params.source.kind === 'captured'
        ? { repositoryRootPath: params.source.comparison.repository.rootPath, source: params.source.comparison.source }
        : { repositoryRootPath: params.source.root, source: { kind: 'workingTree' } });
    const marked = React.useMemo(() => new Set(marks.record?.reviewedChangeKeys ?? []), [marks.record]);
    const [selection, setSelection] = React.useState<HunkReviewCursor | null>(null);
    const [table, setTable] = React.useState<readonly DiffHunkInfo[]>([]);
    const [discardingKey, setDiscardingKey] = React.useState<string | null>(null);
    const currentKey = selection?.path === params.path && units.some(unit => unit.key === selection.key)
        ? selection.key : units[0]?.key ?? null;
    const cursor = currentKey ? { path: params.path, key: currentKey } : null;
    const latest = React.useRef({ params, units, marks, marked, files, cursor, scopeId });
    latest.current = { params, units, marks, marked, files, cursor, scopeId };
    const onHunks = React.useCallback((next: readonly DiffHunkInfo[]) => {
        setTable(previous => previous.length === next.length && previous.every((hunk, index) =>
            hunk.key === next[index]?.key && hunk.firstChangeLineId === next[index]?.firstChangeLineId) ? previous : next);
    }, []);
    const navigate = (direction: 1 | -1, fileOnly = false) => {
        const next = moveHunkReviewCursor(files, cursor, direction, marked, fileOnly);
        if (!next) return;
        setSelection(next);
        params.onNavigate?.(next);
    };
    const resolve = (key: string) => {
        const unit = resolveHunkReviewUnit({ key, renderedScopeId: scopeId,
            currentScopeId: latest.current.scopeId, units: latest.current.units });
        if (!unit) { params.onOutOfDate?.(); return null; }
        return unit;
    };
    const keep = (key: string) => {
        const unit = resolve(key);
        if (!unit || latest.current.marks.unavailableReason) return;
        params.onReviewAction?.();
        marks.setReviewedKeys([unit.key], !latest.current.marked.has(unit.key));
    };
    // The handler retains the hash that accompanied its rendered row. Current key membership
    // is resolved at invocation; the canonical Discard owner guards the displayed bytes.
    const displayedHash = params.contentHash ?? null;
    const target = (key: string): HunkReviewActionTarget | null => {
        const unit = resolve(key);
        return unit ? { path: params.path, changeKey: key, ...(displayedHash ? { expectedHash: displayedHash } : {}),
            source: params.source, unit } : null;
    };
    const discard = async (key: string) => {
        const current = target(key);
        if (!current || latest.current.params.discardDisabledReason || !params.onDiscard) return;
        params.onReviewAction?.();
        setDiscardingKey(key);
        try { await params.onDiscard(current); }
        finally { setDiscardingKey(null); }
    };
    const ask = (key: string) => {
        const current = target(key);
        if (current) void params.onAsk?.(current);
    };
    const copy = (key: string) => {
        const unit = resolve(key);
        if (unit) void Clipboard.setStringAsync(formatHunk(unit.hunk));
    };
    const summary = React.useMemo(() => buildHunkReviewSummary(files, marked), [files, marked]);
    const ordered = React.useMemo(() => orderHunkReviewFiles(files), [files]);
    const fileIndex = ordered.findIndex(file => file.path === params.path);
    const numberOffset = ordered.slice(0, Math.max(0, fileIndex)).reduce((sum, file) => sum + file.keys.length, 0);
    const currentIndex = currentKey ? units.findIndex(unit => unit.key === currentKey) : -1;
    const nextFile = moveHunkReviewCursor(files, cursor, 1, marked, true);
    const hunks: DiffViewerHunks = {
        onHunks, currentIndex: currentIndex < 0 ? null : currentIndex, numberOffset,
        stateOf: hunk => discardingKey === hunk.key ? 'discarding' : marked.has(hunk.key) ? 'kept' : 'open',
        disabledReason: (_hunk, action) => action === 'keep' ? marks.unavailableReason
            : action === 'discard' ? params.discardDisabledReason ?? null : null,
        actions: { keep: hunk => keep(hunk.key), copy: hunk => copy(hunk.key),
            ...(params.onDiscard ? { discard: (hunk: DiffHunkInfo) => { void discard(hunk.key); } } : {}),
            ...(params.onAsk ? { ask: (hunk: DiffHunkInfo) => ask(hunk.key) } : {}) },
    };
    return {
        hunks, reviewUnits: units, cursor, currentIndex, currentHunk: table.find(hunk => hunk.key === currentKey) ?? null,
        strip: { ...summary, currentOrdinal: currentIndex < 0 ? 0 : numberOffset + currentIndex + 1,
            canKeepAll: !marks.unavailableReason && units.some(unit => !marked.has(unit.key)),
            nextFile: nextFile?.path !== params.path ? nextFile?.path ?? null : null,
            fileComplete: units.length > 0 && units.every(unit => marked.has(unit.key)) },
        next: () => navigate(1), previous: () => navigate(-1), nextFile: () => navigate(1, true), previousFile: () => navigate(-1, true),
        keepCurrent: () => { if (currentKey) keep(currentKey); },
        discardCurrent: params.onDiscard ? () => { if (currentKey) void discard(currentKey); } : undefined,
        askCurrent: params.onAsk ? () => { if (currentKey) ask(currentKey); } : undefined,
        keepAll: () => { if (!marks.unavailableReason && units.length > 0) {
            params.onReviewAction?.(); marks.setReviewedKeys(units.map(unit => unit.key), true);
        } },
        reset: marks.clear, undo: params.undo,
    };
}
