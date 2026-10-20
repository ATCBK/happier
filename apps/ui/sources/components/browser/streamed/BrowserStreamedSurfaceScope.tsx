import * as React from 'react';

import type { BrowserStreamedSurfaceRuntime } from '../adapters/BrowserStreamedTarget';

type BrowserStreamedChrome = Pick<BrowserStreamedSurfaceRuntime,
    'machineName' | 'firstUse' | 'firstUseTargetUrl' | 'unavailableReason' | 'onRetry'>;

const ChromeContext = React.createContext<BrowserStreamedChrome | null | undefined>(undefined);
const PictureContext = React.createContext<BrowserStreamedSurfaceRuntime | null | undefined>(undefined);

/** Keep the existing stream owner below the host; only its picture subscribes to frames. */
export function BrowserStreamedSurfaceScope(props: Readonly<{
    runtime: BrowserStreamedSurfaceRuntime | null;
    children: React.ReactNode;
}>): React.ReactElement {
    const runtime = props.runtime;
    const present = runtime !== null;
    const machineName = runtime?.machineName ?? null;
    const firstUse = runtime?.firstUse;
    const firstUseTargetUrl = runtime?.firstUseTargetUrl;
    const unavailableReason = runtime?.unavailableReason;
    const onRetry = runtime?.onRetry;
    const chrome = React.useMemo<BrowserStreamedChrome | null>(() => present
        ? { machineName, firstUse, firstUseTargetUrl, unavailableReason, onRetry } : null,
    [present, machineName, firstUse, firstUseTargetUrl, unavailableReason, onRetry]);
    return <ChromeContext.Provider value={chrome}>
        <PictureContext.Provider value={runtime}>{props.children}</PictureContext.Provider>
    </ChromeContext.Provider>;
}

/** Explicit runtimes remain usable by standalone shells without a live scope. */
export function useBrowserStreamedChrome(fallback: BrowserStreamedSurfaceRuntime | null): BrowserStreamedChrome | null {
    const runtime = React.useContext(ChromeContext);
    return runtime === undefined ? fallback : runtime;
}

export function useBrowserStreamedPicture(fallback: BrowserStreamedSurfaceRuntime | null): BrowserStreamedSurfaceRuntime | null {
    const runtime = React.useContext(PictureContext);
    return runtime === undefined ? fallback : runtime;
}
