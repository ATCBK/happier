import type { ReactTestInstance } from 'react-test-renderer';

type Side = 'top' | 'bottom' | 'left' | 'right';

export type HitFrameReach = Readonly<Record<Side, number>>;

export type HitArea = Readonly<{
    /** The drawn box: the layout size the control's own style declares (or the size the caller measured). */
    drawn: Readonly<{ width: number; height: number }>;
    /** How far the hit area reaches past the drawn box on each side, border excluded. */
    insets: HitFrameReach;
    /** The effective hit rect: the drawn box plus its insets. */
    width: number;
    height: number;
}>;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') return flattenStyle(style({ pressed: false }));
    if (Array.isArray(style)) return style.reduce<Record<string, unknown>>((acc, entry) => Object.assign(acc, flattenStyle(entry)), {});
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function findHitFrame(root: ReactTestInstance): ReactTestInstance | undefined {
    return root.findAll((node) => node.props?.dataSet?.happierHitArea === 'true')[0];
}

/**
 * How far the web hit area of the pressable under `root` reaches past its drawn box on each side: the
 * shared pressable renders it as an invisible absolute frame (`dataSet.happierHitArea`) offset by its
 * reach, so a test can assert the reach a control declares without measuring a browser. `null` when
 * no hit area applies.
 */
export function readHitFrameReach(root: ReactTestInstance): HitFrameReach | null {
    const frame = findHitFrame(root);
    if (!frame) return null;
    const style = frame.props.style as Record<Side, number>;
    return { top: -style.top, bottom: -style.bottom, left: -style.left, right: -style.right };
}

/**
 * The effective hit rect of the pressable `node`, as the shared hit-area owner rendered it: native
 * `hitSlop` (a number or per-side insets), or on the web the invisible `[data-happier-hit-area]` frame
 * inside the pressable (react-native-web ignores `hitSlop`). The frame is offset from the padding box, so
 * the pressable's own border width is taken back out: the reach is measured from the drawn edge.
 *
 * `drawn` defaults to the width/height the node's style declares; pass the size the layout engine
 * reported when the style is a percentage or the owner sizes the reach from a measured box.
 */
export function readHitArea(node: ReactTestInstance, drawn?: Readonly<{ width: number; height: number }>): HitArea {
    const style = flattenStyle(node.props.style);
    const box = drawn ?? {
        width: Math.max(Number(style.width ?? 0), Number(style.minWidth ?? 0)),
        height: Math.max(Number(style.height ?? 0), Number(style.minHeight ?? 0)),
    };
    const slop = node.props.hitSlop as number | Partial<HitFrameReach> | null | undefined;
    const frame = findHitFrame(node);
    const frameStyle = frame ? flattenStyle(frame.props.style) : {};
    const border = (side: Side): number => Number(style[`border${side[0]!.toUpperCase()}${side.slice(1)}Width`] ?? style.borderWidth ?? 0);
    const inset = (side: Side): number => {
        if (typeof slop === 'number') return slop;
        if (slop) return Number(slop[side] ?? 0);
        return frame ? Math.abs(Number(frameStyle[side] ?? 0)) - border(side) : 0;
    };
    const insets = { top: inset('top'), bottom: inset('bottom'), left: inset('left'), right: inset('right') };
    return {
        drawn: box,
        insets,
        width: box.width + insets.left + insets.right,
        height: box.height + insets.top + insets.bottom,
    };
}

/**
 * How many px two neighbouring hit areas overlap (0 when they are clear). `gap` is the distance between
 * the two drawn boxes along `axis`; `first` precedes `second` (left/top before right/bottom). Neighbours
 * split the gap: the reaches that face each other must fit inside it.
 */
export function hitAreaOverlap(
    first: HitArea,
    second: HitArea,
    options: Readonly<{ axis: 'horizontal' | 'vertical'; gap?: number }>,
): number {
    const facing = options.axis === 'horizontal'
        ? first.insets.right + second.insets.left
        : first.insets.bottom + second.insets.top;
    return Math.max(0, facing - (options.gap ?? 0));
}
