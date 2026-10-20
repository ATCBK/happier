import * as React from 'react';
import { t } from '@/text';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useResizableSize, type DockedPaneResizeCommitMeta, HappierResizeHandle as ResizablePaneDividerHandle, resolveResizablePaneNativeTouchTargetSize } from '@happier-dev/plugin-ui/presentation';
import type { SplitCanvasAxis } from '../model/splitCanvasTypes';
import { SPLIT_CANVAS_DEFAULT_RATIO } from '../model/splitCanvasReducer';

function roundRatio(value: number): number {
    return Number(value.toFixed(4));
}

export const SPLIT_CANVAS_DIVIDER_SIZE_PX = { row: 10, column: 18 } as const;

export const SplitCanvasDivider = React.memo((props: Readonly<{
    splitId: string;
    axis: SplitCanvasAxis;
    containerSizePx: number;
    ratio: number;
    minRatio: number;
    maxRatio: number;
    gutterSizePx?: number;
    onCommitRatio: (ratio: number, meta?: DockedPaneResizeCommitMeta) => void;
    onDragRatio?: (ratio: number | null, meta?: DockedPaneResizeCommitMeta | null) => void;
}>) => {
    const { theme } = useUnistyles();
    const safeContainerSizePx = Math.max(props.containerSizePx, 1);
    const {
        panHandlers,
        webHandleProps,
        accessibilityHandleProps,
    } = useResizableSize({
        axis: props.axis === 'row' ? 'x' : 'y',
        resizeEdge: 'end',
        sizePx: safeContainerSizePx * props.ratio,
        minSizePx: safeContainerSizePx * props.minRatio,
        maxSizePx: safeContainerSizePx * props.maxRatio,
        onResetRequest: () => props.onCommitRatio(SPLIT_CANVAS_DEFAULT_RATIO),
        onCommitSizePx: (sizePx, meta) => {
            props.onCommitRatio(roundRatio(sizePx / safeContainerSizePx), meta);
        },
        onDragSizePx: (sizePx, meta) => {
            props.onDragRatio?.(
                typeof sizePx === 'number' ? roundRatio(sizePx / safeContainerSizePx) : null,
                meta ?? null,
            );
        },
    });

    const vertical = props.axis === 'row';
    const nativeTouchTargetSize = resolveResizablePaneNativeTouchTargetSize();
    const visualHandleSize = props.gutterSizePx ?? SPLIT_CANVAS_DIVIDER_SIZE_PX[props.axis];
    const targetSize = nativeTouchTargetSize ?? visualHandleSize;
    const layoutCompensation = (targetSize - visualHandleSize) / 2;

    return (
        <View
            testID={`split-canvas-divider-${props.splitId}`}
            style={{
                width: vertical ? targetSize : '100%',
                height: vertical ? '100%' : targetSize,
                ...(nativeTouchTargetSize === null
                    ? null
                    : vertical
                        ? { marginHorizontal: -layoutCompensation }
                        : { marginVertical: -layoutCompensation }),
                flexShrink: 0,
                position: 'relative',
            }}
        >
            <ResizablePaneDividerHandle
                labels={{ label: t('ui.resizableDockedPane.resizeA11y'), hint: t('ui.resizableDockedPane.resizeHint'), value: (px) => t('ui.resizableDockedPane.resizeValue', { px }) }}
                axis={vertical ? 'x' : 'y'}
                testID={`split-canvas-divider-handle-${props.splitId}`}
                interactionProps={Platform.OS === 'web' ? webHandleProps : panHandlers}
                accessibilityHandleProps={accessibilityHandleProps}
                style={{
                    position: 'absolute',
                    ...(vertical
                        ? {
                            top: 0,
                            bottom: 0,
                            width: visualHandleSize,
                            left: 0,
                        }
                        : {
                            left: 0,
                            right: 0,
                            height: visualHandleSize,
                        }),
                    zIndex: 100,
                }}
                indicatorColor={vertical ? theme.colors.border.default : theme.colors.text.secondary}
                indicatorOpacity={vertical ? 0.9 : 0.5}
            />
        </View>
    );
});
