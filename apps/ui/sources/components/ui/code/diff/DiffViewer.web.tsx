import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

import { useSetting } from '@/sync/store/settingsReadHooks';
import { LazyMountOnScreen } from '@/components/ui/performance/LazyMountOnScreen';

import type { DiffViewerProps } from './diffViewerTypes';
import { HappierUnifiedDiffViewer } from './happier/HappierUnifiedDiffViewer';
import { HappierTextDiffViewer } from './happier/HappierTextDiffViewer';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { isPierreDiffKillSwitchEnabled, supportsPierreRuntime } from './pierre/pierreRuntimeSupport.web';
import { useInitialPresentationReadiness } from '@/components/ui/presentation/InitialPresentationReadinessContext';
import { useEffectiveDiffWrapLines } from './diffPresentationStyle';
import { ProseDiffViewer } from './prose/ProseDiffViewer';

const PierreDiffViewer = retryableLazy(async () => {
    const renderer = await import('./pierre/PierreDiffViewer.web');
    return { default: renderer.PierreDiffViewer };
});

export const DiffViewer = React.memo<DiffViewerProps>((props) => {
    const rendererMode = useSetting('filesDiffRendererMode');
    const initialPresentationReadiness = useInitialPresentationReadiness();
    const wrapLines = useEffectiveDiffWrapLines(props.wrapLines);

    // Prose is its own face on every renderer: a reading layout, not a code diff.
    if (props.mode === 'text' && props.face === 'prose') return <ProseDiffViewer {...props} />;

    const wantsPierre = rendererMode === 'pierre';
    const rangeInteractionRequired = typeof props.onPressLineRange === 'function'
        && (props.interactionMode ?? 'read') !== 'read';
    const pierreAllowed = wantsPierre
        && !rangeInteractionRequired
        // Find uses the canonical CodeLine range renderer and line virtualizer target.
        // @pierre/diffs 1.1.0-beta.13 exposes neither a FileDiff line-target handle nor
        // a Virtualizer offscreen line-reveal API. Its DOM-only reveal misses unmounted rows.
        // Keep the saved renderer preference untouched; closing Find restores Pierre.
        && props.findActive !== true
        && isPierreDiffKillSwitchEnabled()
        && supportsPierreRuntime();

    if (pierreAllowed) {
        // An inline diff (a hunk card, a tool result) shows its code at once with the canonical line
        // renderer while the Pierre chunk and its worker load, so the reserved body is never an empty
        // card. A virtualized list diff can be very large, so it keeps the pane's loading state.
        const loading = props.virtualized === true
            ? <PaneLoadingFallback testID="pierre-diff-loading" />
            : props.mode === 'unified'
                ? <HappierUnifiedDiffViewer {...props} wrapLines={wrapLines} />
                : <HappierTextDiffViewer {...props} wrapLines={wrapLines} />;
        const viewer = (
            <React.Suspense fallback={loading}>
                <PierreDiffViewer {...props} wrapLines={wrapLines} />
            </React.Suspense>
        );
        return props.virtualized === true ? (
            <LazyMountOnScreen
                initiallyVisible={initialPresentationReadiness?.presentationPending === true}
            >
                {viewer}
            </LazyMountOnScreen>
        ) : viewer;
    }

    if (props.mode === 'unified') {
        return <HappierUnifiedDiffViewer {...props} wrapLines={wrapLines} />;
    }
    return <HappierTextDiffViewer {...props} wrapLines={wrapLines} />;
});
