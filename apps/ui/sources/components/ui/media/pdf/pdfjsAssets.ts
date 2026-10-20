/** Keep every pdf.js support URL at the library's exact version (immutable server cache). */
export function resolvePdfjsAssetPaths(version: string) {
    const root = `/pdfjs/${version}/`;
    return {
        workerSrc: `${root}pdf.worker.min.js`,
        cMapUrl: `${root}cmaps/`,
        standardFontDataUrl: `${root}standard_fonts/`,
        wasmUrl: `${root}wasm/`,
        iccUrl: `${root}iccs/`,
    };
}
