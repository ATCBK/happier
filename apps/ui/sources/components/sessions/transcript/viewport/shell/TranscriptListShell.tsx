import * as React from 'react';
import { View } from 'react-native';

import { MarkdownCodeBlockWrapStateProvider } from '@/components/markdown/MarkdownCodeBlockWrapState';

import { resolveTranscriptListRenderer } from './renderer/resolveTranscriptListRenderer';
import type {
    TranscriptListShellProps,
    TranscriptListShellRef,
} from './renderer/types';

export type {
    TranscriptListShellPlatformInteractionProps,
    TranscriptListShellProps,
    TranscriptListShellRef,
    TranscriptRendererAtEndState,
} from './renderer/types';

const TRANSCRIPT_LIST_SHELL_STYLE = { flex: 1, minHeight: 0 } as const;

function TranscriptListShellInner<TItem>(
    props: TranscriptListShellProps<TItem>,
    ref: React.ForwardedRef<TranscriptListShellRef<TItem>>,
): React.ReactElement {
    const renderer = resolveTranscriptListRenderer();
    const Renderer = renderer.Component;
    const rendererRef = React.useRef<TranscriptListShellRef<TItem> | null>(null);
    const commitRendererRef = React.useCallback((node: TranscriptListShellRef<TItem> | null) => {
        rendererRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
    }, [ref]);
    // Bounded transcripts have no outer jump lifecycle; their existing renderer owns the
    // mounted target. The main transcript supplies its full explicit-jump owner instead.
    const revealNativeItem = React.useCallback((placement: Readonly<{ index: number; itemOffsetPx: number }>) => {
        const target = rendererRef.current;
        if (!target) return;
        const release = target.beginExplicitJumpTakeover?.(Symbol('transcript-native-item-reveal'));
        try {
            void target.scrollToIndex({ index: placement.index, viewOffset: placement.itemOffsetPx, animated: false });
        } finally {
            release?.();
        }
    }, []);

    return (
        <MarkdownCodeBlockWrapStateProvider>
            <View style={TRANSCRIPT_LIST_SHELL_STYLE}>
                <Renderer
                    ref={commitRendererRef}
                    {...props}
                    onRevealNativeItem={props.onRevealNativeItem ?? revealNativeItem}
                />
                {props.olderLoadOverlay ?? null}
                {props.catchUpOverlay ?? null}
            </View>
        </MarkdownCodeBlockWrapStateProvider>
    );
}

export const TranscriptListShell = React.forwardRef(TranscriptListShellInner) as <TItem>(
    props: TranscriptListShellProps<TItem> & React.RefAttributes<TranscriptListShellRef<TItem>>,
) => React.ReactElement;
