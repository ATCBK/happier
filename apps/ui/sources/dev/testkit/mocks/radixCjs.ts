import * as React from 'react';

type HostProps = Readonly<Record<string, unknown> & { children?: React.ReactNode; asChild?: boolean }>;

function createRadixHostComponent(tagName: string) {
    return function RadixHostComponent(props: HostProps) {
        const { children, asChild, ...rest } = props;
        // `asChild` parts render their child in place in Radix, so they add no host node here either.
        if (asChild) return React.createElement(React.Fragment, null, children);
        return React.createElement(tagName, rest, children);
    };
}

/**
 * `@/utils/web/radixCjs` for renderer tests without a DOM (the default `node` environment): every Radix
 * part the app loads is a named host element (or, with `asChild`, its child), so trees stay inspectable
 * and no Radix effect touches `document`.
 */
export function createRadixCjsModuleMock() {
    // CommonJS require returns the same exports on each read. Stable component
    // types preserve the body and its effects when a real overlay rerenders.
    const dialog = {
        Root: createRadixHostComponent('DialogRoot'),
        Portal: createRadixHostComponent('DialogPortal'),
        Overlay: createRadixHostComponent('DialogOverlay'),
        Content: createRadixHostComponent('DialogContent'),
        Title: createRadixHostComponent('DialogTitle'),
    };
    const dismissableLayer = {
        Root: createRadixHostComponent('DismissableLayer'),
        Branch: createRadixHostComponent('DismissableLayerBranch'),
        DismissableLayerBranch: createRadixHostComponent('DismissableLayerBranch'),
    };
    const focusScope = {
        Root: createRadixHostComponent('FocusScope'),
        FocusScope: createRadixHostComponent('FocusScope'),
    };
    return {
        requireRadixDialog: () => dialog,
        requireRadixDismissableLayer: () => dismissableLayer,
        requireRadixFocusScope: () => focusScope,
    };
}

/**
 * `@/utils/web/radixCjs` for DOM tests (`jsdom`): the real Radix modules, loaded as ES modules because
 * the app's CommonJS `require` is not available there. Real layers and focus scopes are what make
 * overlay stacking (Escape, focus containment) observable.
 */
export async function createRadixCjsRealModule() {
    const [dialog, dismissableLayer, focusScope] = await Promise.all([
        import('@radix-ui/react-dialog'),
        import('@radix-ui/react-dismissable-layer'),
        import('@radix-ui/react-focus-scope'),
    ]);
    return {
        requireRadixDialog: () => dialog,
        requireRadixDismissableLayer: () => dismissableLayer,
        requireRadixFocusScope: () => focusScope,
    };
}
