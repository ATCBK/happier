// @vitest-environment jsdom
import { performance as nodePerformance, PerformanceObserver as NodePerformanceObserver } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { installWebReactPerformanceMeasureCleanup } from './webReactPerformanceMeasures';

let dispose: (() => void) | undefined;
afterEach(() => {
    dispose?.();
    dispose = undefined;
    nodePerformance.clearMeasures();
    vi.unstubAllGlobals();
});

it('releases completed React prop measurements across repeated renders while preserving other timing consumers', async () => {
    // Use the actual User Timing producer and observer, not an array that only
    // imitates the buffer whose native retention caused the browser growth.
    vi.stubGlobal('performance', nodePerformance);
    vi.stubGlobal('PerformanceObserver', NodePerformanceObserver);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // Vitest's console omits the browser timestamp boundary that enables
    // React 19.2's component tracks. Keep the real measure producer beneath it.
    vi.stubGlobal('console', { ...console, timeStamp: () => {} });
    const { createRoot } = await import('react-dom/client');
    const element = document.createElement('div');
    document.body.appendChild(element);
    const root = createRoot(element);
    let observed = 0;
    const witness = new NodePerformanceObserver(list => {
        observed += list.getEntries().filter(entry => entry.name.startsWith('\u200b')).length;
    });
    dispose = installWebReactPerformanceMeasureCleanup();
    // A later observer must still receive the entries even when cleanup runs first.
    witness.observe({ type: 'measure' });
    const points = Array.from({ length: 401 }, (_, id) => ({ id, total: 42 }));
    function UsageRefresh(props: Readonly<{ revision: number; points: typeof points }>) {
        return <span>{props.revision}:{props.points.reduce((sum, point) => sum + point.total, 0)}</span>;
    }
    nodePerformance.measure('usage-read', { start: nodePerformance.now() });
    try {
        for (let revision = 0; revision < 32; revision++) {
            await React.act(async () => { root.render(<UsageRefresh revision={revision} points={points} />); });
            await setImmediate();
            await setImmediate();
            expect(element.textContent).toBe(`${revision}:16842`);
        }
        expect(observed, 'the real React renderer must exercise its User Timing producer').toBeGreaterThan(0);
        const retained = nodePerformance.getEntriesByType('measure');
        expect(retained.filter(entry => entry.name.startsWith('\u200b')).length,
            'completed render details must not accumulate in the native User Timing buffer').toBe(0);
        expect(retained.filter(entry => entry.name === 'usage-read')).toHaveLength(1);
    } finally {
        witness.disconnect();
        await React.act(async () => root.unmount());
        element.remove();
    }
});

it('stops consuming measurements when its development observer is retired', async () => {
    vi.stubGlobal('performance', nodePerformance);
    vi.stubGlobal('PerformanceObserver', NodePerformanceObserver);
    dispose = installWebReactPerformanceMeasureCleanup();
    dispose();
    nodePerformance.measure('\u200bUsageRefresh', { start: nodePerformance.now() });
    await setImmediate();
    expect(nodePerformance.getEntriesByName('\u200bUsageRefresh')).toHaveLength(1);
});
