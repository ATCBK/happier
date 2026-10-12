import { createPlanetDots, createPlanetScene, gainPlanetScene, type PlanetScene } from '@happier-dev/brand/planet';
import type { PlanetCanvasProps } from './planetCanvas.types';

/**
 * A mounted canvas retains its current value-keyed scene, not every slider position. A moment's gain
 * (the ripple's brightening) only re-colours the sampled scene, so the scene at rest is kept and
 * re-gained each frame rather than sampled again.
 */
export function createPlanetCanvasSceneCache() {
    let key: string | undefined;
    let scene: PlanetScene | undefined;
    return (props: PlanetCanvasProps, dpr: number): PlanetScene => {
        if (props.scene) return props.scene;
        const gain = props.options?.gain ?? 1;
        const input = props.options ? { ...props.options, gain: undefined } : props.mark;
        const nextKey = JSON.stringify([input, dpr]);
        if (key === nextKey && scene) return gainPlanetScene(scene, gain);
        scene = props.options ? createPlanetScene({ ...props.options, gain: undefined, dpr }) : {
            body: createPlanetDots(props.mark).map((dot, index) => ({
                x: dot.x, y: dot.y, r: dot.radius * (props.mark.radiusScale ?? 1), rgb: dot.rgb,
                opacity: dot.opacity * (props.mark.opacityScale ?? 1), i: index, j: 0,
            })),
            haze: [], cells: [],
        };
        key = nextKey;
        return gainPlanetScene(scene, gain);
    };
}

/** Port of MO.ctxOf: an exact whole-device-pixel box avoids a resampled seam. */
export function snapCanvasBox(width: number, height: number, dpr: number) {
    const w = Math.floor(width * dpr + 1e-3) / dpr;
    const h = Math.floor(height * dpr + 1e-3) / dpr;
    return { width: w, height: h, pixelWidth: Math.round(w * dpr), pixelHeight: Math.round(h * dpr), dpr };
}
