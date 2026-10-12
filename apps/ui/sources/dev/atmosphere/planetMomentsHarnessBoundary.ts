import * as React from 'react';

/**
 * Browser host boundary for the U8 planet-moments harness: just enough of React Native's surface for the
 * product's Loading/Welcome components to render as positioned DOM in a real browser. Not a product path.
 */
type Style = Record<string, unknown>;
const flatten = (style: unknown): Style => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
export const Platform = { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default };
export const StyleSheet = {
    flatten,
    create: <T,>(styles: T) => styles,
    absoluteFill: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 },
};
export const PixelRatio = { get: () => window.devicePixelRatio || 1 };
export const AppState = {
    get currentState() { return document.hidden ? 'background' : 'active'; },
    addEventListener(_name: string, listener: (state: string) => void) {
        const changed = () => listener(document.hidden ? 'background' : 'active');
        document.addEventListener('visibilitychange', changed);
        return { remove: () => document.removeEventListener('visibilitychange', changed) };
    },
};
export const Easing = { bezier: () => (t: number) => t, linear: (t: number) => t, ease: (t: number) => t, out: (f: unknown) => f, in: (f: unknown) => f, inOut: (f: unknown) => f };
export const View = React.forwardRef(function View(props: { style?: unknown; children?: React.ReactNode; pointerEvents?: string; testID?: string }, ref: React.Ref<HTMLDivElement>) {
    const style = flatten(props.style);
    const pointerEvents = props.pointerEvents === 'none' ? 'none' : undefined;
    return React.createElement('div', { ref, 'data-testid': props.testID,
        style: { display: 'flex', flexDirection: 'column', position: 'relative', boxSizing: 'border-box', pointerEvents, ...style } }, props.children);
});
