let activeCleanup: (() => void) | undefined;

/**
 * React DOM 19.2 prefixes component User Timing entries with a zero-width space
 * (logComponentRender/logComponentEffect). Their completed prop-diff details
 * otherwise stay in the browser's native timing buffer for the whole tab.
 * Observers and DevTools receive the entries before this buffer is released.
 */
export function installWebReactPerformanceMeasureCleanup(): () => void {
    if (activeCleanup) return activeCleanup;
    if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes.includes('measure')) {
        return () => {};
    }
    const timing = performance;
    const observer = new PerformanceObserver(list => {
        const names = new Set<string>();
        for (const entry of list.getEntries()) {
            // Reading detail would deserialize the large prop diff again.
            if (entry.name.startsWith('\u200b')) names.add(entry.name);
        }
        for (const name of names) timing.clearMeasures(name);
    });
    observer.observe({ type: 'measure', buffered: true });
    activeCleanup = () => {
        observer.disconnect();
        activeCleanup = undefined;
    };
    return activeCleanup;
}
