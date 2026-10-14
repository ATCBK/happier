import type { ReactNode } from 'react';

/** DOM portals are a renderer boundary; React test-renderer keeps their children in its own tree. */
export function createReactDomCjsRendererMock() {
    const reactDOM = { createPortal: (children: ReactNode) => children };
    return { requireReactDOM: () => reactDOM, preloadReactDOM: async () => reactDOM };
}
