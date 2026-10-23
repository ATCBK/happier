import * as React from 'react';
import { StyleSheet } from 'react-native';
import { getMonoFont, getHappierFontFamily, themeFontFamilyVariableName } from '@/constants/Typography';
import { createPlanetCanvasSceneCache, snapCanvasBox } from './planetCanvasScene';
import { paintPlanetScene } from './planetCanvasPaint.web';
import { orderedFade } from '@happier-dev/brand/atmosphere';
import type { PlanetCanvasProps } from './planetCanvas.types';
import { usePlanetDigits } from './usePlanetDigits';

// Canvas text does not resolve CSS var() itself, so read the typography owner's variable.
export function planetCanvasFonts() {
    const family = (weight: 'regular' | 'semiBold') => {
        const value = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(themeFontFamilyVariableName('mono', weight)).trim();
        return value || `"${getHappierFontFamily('mono', weight)}", "IBM Plex Mono", ui-monospace, monospace`;
    };
    return { regular: family('regular'), semiBold: family('semiBold') };
}

export const PlanetCanvas = React.memo(function PlanetCanvas(props: PlanetCanvasProps) {
    return <PlanetDigits {...props} />;
});

/** Repaint one canvas, preserving the original source-atop composition rather than overlaying it. */
function PlanetDigits(input: PlanetCanvasProps) {
    const props = usePlanetDigits(input);
    const ref = React.useRef<HTMLCanvasElement>(null);
    const ready = React.useRef(props.onReady); ready.current = props.onReady;
    const failed = React.useRef(props.onError); failed.current = props.onError;
    const dpr = props.options?.dpr ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    const box = snapCanvasBox(props.width, props.height, dpr);
    const resolveScene = React.useMemo(createPlanetCanvasSceneCache, []);
    const scene = resolveScene(props, dpr);
    const fadeFrom = props.fade?.from, fadeTo = props.fade?.to;
    React.useLayoutEffect(() => {
        let cancelled = false;
        const draw = async () => {
            const fonts = planetCanvasFonts();
            // Loaded faces need no wait, so a moment's redraw (the ripple's gain) lands in its own frame.
            const faces = [`12px ${fonts.regular}`, `600 12px ${fonts.semiBold}`];
            if (scene.cells.length && !faces.every(face => document.fonts.check(face))) await Promise.all(faces.map(face => document.fonts.load(face)));
            if (cancelled) return;
            const context = ref.current?.getContext('2d');
            if (!context) return;
            context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, box.pixelWidth, box.pixelHeight);
            const scale = props.mark ? props.width / (props.mark.size ?? 24) : 1;
            context.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
            paintPlanetScene(context, scene, fonts, props.mark?.ink ?? props.ink);
            if (fadeFrom !== undefined && fadeTo !== undefined) {
                // Only the rows the fade touches go through the canvas store (lab at-planet.js).
                const top = Math.max(0, Math.floor(fadeFrom * dpr));
                if (top < box.pixelHeight) {
                    context.setTransform(1, 0, 0, 1, 0, 0);
                    const image = context.getImageData(0, top, box.pixelWidth, box.pixelHeight - top);
                    const store = new Uint8ClampedArray(box.pixelWidth * box.pixelHeight * 4);
                    store.set(image.data, top * box.pixelWidth * 4);
                    orderedFade(store, box.pixelWidth, box.pixelHeight, fadeFrom, fadeTo, dpr);
                    image.data.set(store.subarray(top * box.pixelWidth * 4));
                    context.putImageData(image, 0, top);
                }
            }
            ready.current?.();
        };
        void draw().catch(error => failed.current?.(error instanceof Error ? error : new Error(String(error))));
        return () => { cancelled = true; };
    }, [box.pixelHeight, box.pixelWidth, dpr, fadeFrom, fadeTo, props.mark?.ink, props.ink, props.mark?.size, props.width, scene]);
    return React.createElement('canvas', {
        ref, width: box.pixelWidth, height: box.pixelHeight, 'data-testid': props.testID, 'aria-hidden': true,
        style: { ...StyleSheet.flatten(props.style), width: box.width, height: box.height, pointerEvents: 'none', display: 'block', fontFamily: getMonoFont() },
    });
}
