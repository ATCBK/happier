import { cpus } from 'node:os';
import { createAtmosphereWorkletCore } from '../../sources/components/atmosphere/backdropWorkletCore.generated.js';

// The brief permits this core-only fallback when no emulator/simulator is available.
const cases = [];
for (const [w, h, dpr] of [[780, 1000, 2], [1440, 500, 1]]) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const k = (y * w + x) * 4;
        rgba[k] = x * 255 / w; rgba[k + 1] = y * 255 / h; rgba[k + 2] = 160; rgba[k + 3] = 255;
    }
    for (const look of ['fine', 'painted']) {
        const core = createAtmosphereWorkletCore();
        const started = performance.now();
        const result = core.renderBackdrop({ source: { rgba, w, h }, look, theme: 'light', page: [245, 245, 245], dpr,
            params: { strength: 1 }, dissolve: { style: 'ordered', from: 0.46, to: 1 } });
        cases.push({ w, h, dpr, look, firstRenderMs: Number((performance.now() - started).toFixed(2)), bytes: result.rgba.byteLength });
    }
}
console.log(JSON.stringify({ runtime: process.version, cpu: cpus()[0].model, scope: 'canonical JS core only; no device decode/PNG/compositor timing', cases }));
