import * as React from 'react';
import { Platform, Pressable, View, type ViewStyle } from 'react-native';
import type { HappierStyleProp } from '../../portableTypes.js';

export function resolveResizablePaneNativeTouchTargetSize(): number | null {
    if (Platform.OS === 'web') return null;
    return Platform.OS === 'android' ? 48 : 44;
}

export const HappierResizeHandle = React.memo((props: Readonly<{
    labels: Readonly<{ label: string; hint?: string; value?: (px: number) => string }>;
    axis: 'x' | 'y';
    /** Omit for a centered divider whose parent already owns the full target. */
    edge?: 'start' | 'end';
    testID?: string;
    style?: HappierStyleProp;
    showIndicator?: boolean;
    indicatorColor?: string;
    indicatorOpacity?: number;
    /** Opaque web/native responder props returned by useResizableSize. */
    interactionProps?: Readonly<Record<string, unknown>>;
    accessibilityHandleProps?: Readonly<{
        accessibilityValue?: Readonly<{ min?: number; max?: number; now?: number }>;
        accessibilityActions?: ReadonlyArray<Readonly<{ name: 'increment' | 'decrement' }>>;
        onAccessibilityAction?: (event: unknown) => void;
    }>;
}>) => {
    const handleRef = React.useRef<React.ElementRef<typeof View>>(null);
    const { onDoubleClick, ...interactionProps } = props.interactionProps ?? {};
    const resetRef = React.useRef(onDoubleClick);
    resetRef.current = onDoubleClick;
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const target = handleRef.current as unknown as Partial<Pick<EventTarget, 'addEventListener' | 'removeEventListener'>> | null;
        if (!target?.addEventListener || !target.removeEventListener) return;
        const reset = () => { if (typeof resetRef.current === 'function') resetRef.current(); };
        target.addEventListener('dblclick', reset);
        return () => target.removeEventListener?.('dblclick', reset);
    }, []);
    const showIndicator = props.showIndicator !== false && typeof props.indicatorColor === 'string';
    const nativeTouchTargetSize = resolveResizablePaneNativeTouchTargetSize();
    const visualHandleSize = props.axis === 'x' ? 10 : 18;
    const inwardExpansion = Math.max(0, (nativeTouchTargetSize ?? visualHandleSize) - visualHandleSize);
    // Native HitRects cannot extend beyond the pane parent. Expand only inward
    // from the owning edge so the full 44/48pt target remains reachable without
    // shifting the visual divider or overlapping the adjacent pane.
    const nativeHitSlop = nativeTouchTargetSize === null || props.edge === undefined
        ? undefined
        : props.axis === 'x'
            ? props.edge === 'start' ? { right: inwardExpansion } : { left: inwardExpansion }
            : props.edge === 'start' ? { bottom: inwardExpansion } : { top: inwardExpansion };
    const centeredNativeTargetStyle: ViewStyle | undefined = nativeTouchTargetSize === null || props.edge !== undefined
        ? undefined
        : props.axis === 'x'
            ? { width: nativeTouchTargetSize }
            : { height: nativeTouchTargetSize };

    return (
        <Pressable
            ref={handleRef}
            testID={props.testID}
            focusable={Platform.OS === 'web'}
            accessibilityRole="adjustable"
            accessibilityLabel={props.labels.label}
            accessibilityHint={props.labels.hint}
            {...interactionProps}
            {...props.accessibilityHandleProps}
            {...resolveDividerValueProps(props.accessibilityHandleProps?.accessibilityValue, props.labels.value)}
            hitSlop={nativeHitSlop}
            style={[
                {
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: props.axis === 'x' ? 'col-resize' : 'row-resize',
                    userSelect: 'none',
                    ...(Platform.OS === 'web' ? { touchAction: 'none' } : null),
                },
                props.style,
                centeredNativeTargetStyle,
            ]}
        >
            {showIndicator ? (
                <View
                    style={props.axis === 'x'
                        ? {
                            width: 1,
                            height: '100%',
                            backgroundColor: props.indicatorColor,
                            opacity: props.indicatorOpacity ?? 1,
                        }
                        : {
                            width: 56,
                            height: 5,
                            borderRadius: 999,
                            backgroundColor: props.indicatorColor,
                            opacity: props.indicatorOpacity ?? 1,
                        }}
                />
            ) : null}
        </Pressable>
    );
});

/**
 * The divider's size as a slider's value, in the ARIA attributes a screen reader announces: React
 * Native Web does not project `accessibilityValue` on a pressable, so the web reads the size from
 * these (min, max, now and the spoken text).
 */
function resolveDividerValueProps(value: Readonly<{ min?: number; max?: number; now?: number }> | undefined, valueLabel?: (px: number) => string) {
    if (Platform.OS !== 'web' || !value || typeof value.now !== 'number') return null;
    const now = Math.round(value.now);
    return {
        role: 'slider',
        'aria-valuenow': now,
        ...(typeof value.min === 'number' ? { 'aria-valuemin': Math.round(value.min) } : {}),
        ...(typeof value.max === 'number' ? { 'aria-valuemax': Math.round(value.max) } : {}),
        'aria-valuetext': valueLabel?.(now) ?? String(now),
    } as Record<string, unknown>;
}

