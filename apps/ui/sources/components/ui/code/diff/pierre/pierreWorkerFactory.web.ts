import { PIERRE_DIFFS_VERSION } from './pierreVersion';

export function createPierreDiffWorker(): Worker {
    const base = typeof window !== 'undefined' && typeof window.location?.origin === 'string'
        ? window.location.origin
        : (typeof document !== 'undefined' && typeof document.baseURI === 'string'
            ? document.baseURI
            : 'http://localhost');

    const url = new URL(`/pierre-diff-worker.${PIERRE_DIFFS_VERSION}.js`, base);
    return new Worker(url, { type: 'module' });
}
