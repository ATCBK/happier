import * as React from 'react';
import { View } from 'react-native';

import { MarkdownCodeBlockWrapStateProvider } from '@/components/markdown/MarkdownCodeBlockWrapState';
import { ComposerKeyboardFloatingInset } from '@/components/sessions/keyboardAvoidance';
import { JumpToBottomButton } from '@/components/sessions/transcript/scroll/JumpToBottomButton';

import { resolveTranscriptListRenderer } from './renderer/resolveTranscriptListRenderer';
import type {
    TranscriptListShellProps,
    TranscriptListShellRef,
    TranscriptRendererAtEndState,
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
    // A conversation frame (a Discussion) has no outer jump owner: the shell shows the transcript's own
    // jump-to-bottom from the renderer's at-end facts. The main transcript passes its richer affordance.
    const conversation = props.frame.capability.kind === 'conversation';
    const [awayFromEnd, setAwayFromEnd] = React.useState(false);
    const hostAtEndChange = props.onRendererAtEndChange;
    const onRendererAtEndChange = React.useCallback((state: TranscriptRendererAtEndState, context: Parameters<NonNullable<typeof hostAtEndChange>>[1]) => {
        setAwayFromEnd(!state.isAtEnd && !state.isNearEnd);
        hostAtEndChange?.(state, context);
    }, [hostAtEndChange]);
    const jumpToEnd = React.useCallback(() => {
        void rendererRef.current?.scrollToEnd?.({ animated: true });
    }, []);
    const jumpToBottom = props.jumpToBottom !== undefined ? props.jumpToBottom
        : conversation && awayFromEnd ? { count: 0, onPress: jumpToEnd } : null;

    return (
        <MarkdownCodeBlockWrapStateProvider>
            <View style={TRANSCRIPT_LIST_SHELL_STYLE}>
                <Renderer
                    ref={commitRendererRef}
                    {...props}
                    onRevealNativeItem={props.onRevealNativeItem ?? revealNativeItem}
                    {...(conversation ? { onRendererAtEndChange } : {})}
                />
                {props.olderLoadOverlay ?? null}
                {props.catchUpOverlay ?? null}
                {jumpToBottom ? (
                    <ComposerKeyboardFloatingInset
                        testID="transcript-jump-to-bottom-keyboard-offset"
                        baseBottom={12}
                        style={{ position: 'absolute', right: 12 }}
                    >
                        <JumpToBottomButton
                            testID="transcript-jump-to-bottom"
                            count={jumpToBottom.count}
                            onPress={jumpToBottom.onPress}
                            presentation={jumpToBottom.presentation}
                        />
                    </ComposerKeyboardFloatingInset>
                ) : null}
            </View>
        </MarkdownCodeBlockWrapStateProvider>
    );
}

export const TranscriptListShell = React.forwardRef(TranscriptListShellInner) as <TItem>(
    props: TranscriptListShellProps<TItem> & React.RefAttributes<TranscriptListShellRef<TItem>>,
) => React.ReactElement;
