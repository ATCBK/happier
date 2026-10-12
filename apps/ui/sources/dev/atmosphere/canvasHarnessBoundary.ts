/** Browser host boundary for the standalone drawing harness, not a product replacement. */
export const Platform = { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default };
export const StyleSheet = { flatten: (style: unknown): Record<string, unknown> => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) };
export const AppState = {
    get currentState() { return document.hidden ? 'background' : 'active'; },
    addEventListener(_name: string, listener: (state: string) => void) {
        const changed = () => listener(document.hidden ? 'background' : 'active');
        document.addEventListener('visibilitychange', changed);
        return { remove: () => document.removeEventListener('visibilitychange', changed) };
    },
};

/** Moment harness: a View is a positioned div; easing curves are not exercised by the stills. */
export function View(props: { style?: unknown; children?: unknown; pointerEvents?: string }) {
    const React = require('react') as typeof import('react');
    return React.createElement('div', { style: { position: 'relative', display: 'flex', ...StyleSheet.flatten(props.style) } }, props.children as never);
}
export const Easing = { bezier: () => (t: number) => t, linear: (t: number) => t, ease: (t: number) => t, out: (f: unknown) => f, in: (f: unknown) => f, inOut: (f: unknown) => f };
