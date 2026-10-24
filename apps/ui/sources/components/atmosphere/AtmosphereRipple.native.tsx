import * as React from 'react';
import { PixelRatio } from 'react-native';
import { Canvas, Image, type SkImage } from '@shopify/react-native-skia';
import { atmosphereDigitLattice } from '@happier-dev/brand/atmosphere';
import { backdropGlyphAtlas } from './backdropGlyphAtlas.native';
import { renderNativeRipple } from './renderBackdrop.native';
import { snapCanvasBox } from './planetCanvasScene';
import { useCanvasRenderState } from './useCanvasRenderState';
import type { AtmosphereRippleHandle, AtmosphereRippleProps, AtmosphereRippleRing } from './atmosphereRipple.types';

export const ATMOSPHERE_RIPPLE_RING = true;

/** The same typewriter ring pixels as web, computed on the existing secondary backdrop runtime. */
export const AtmosphereRipple = React.forwardRef<AtmosphereRippleHandle, AtmosphereRippleProps>(function AtmosphereRipple(props, handle) {
    const dpr = PixelRatio.get();
    const box = snapCanvasBox(props.width, props.height, dpr);
    const state = useCanvasRenderState({ size: { width: props.width, height: props.height } });
    const [image, setImage] = React.useState<SkImage | null>(null);
    const [error, setError] = React.useState<unknown>(null);
    const latest = React.useRef<AtmosphereRippleRing>(null);
    const draw = React.useRef<(() => void) | null>(null);
    React.useImperativeHandle(handle, () => ({ paint(ring) { latest.current = ring; draw.current?.(); } }), []);
    const { theme } = props;
    const [red, green, blue] = props.page;
    React.useEffect(() => {
        if (!state.visible) return;
        let live = true, busy = false;
        const lattice = atmosphereDigitLattice(box.pixelWidth, box.pixelHeight, dpr);
        void backdropGlyphAtlas({ w: lattice.cw / dpr, h: lattice.ch / dpr, chars: '0123456789' }, dpr).then(glyphs => {
            if (!live) return;
            const drain = async () => {
                if (!live || busy) return;
                const ring = latest.current;
                if (!ring) { setImage(null); return; }
                busy = true;
                try {
                    const next = await renderNativeRipple(ring.progress, { w: box.pixelWidth, h: box.pixelHeight, page: [red, green, blue], theme, glyphs, dpr, x: ring.x, y: ring.y });
                    if (live && latest.current !== null) setImage(next);
                    else next.dispose();
                } finally { busy = false; }
                // Coalesce display ticks while the worker is busy; never queue stale full-pane frames.
                if (live && latest.current !== ring) draw.current?.();
            };
            draw.current = () => { void drain().catch(failure => { if (live) setError(failure); }); };
            draw.current();
        }).catch(failure => { if (live) setError(failure); });
        return () => { live = false; draw.current = null; };
    }, [box.pixelWidth, box.pixelHeight, dpr, red, green, blue, state.visible, theme]);
    React.useEffect(() => () => image?.dispose(), [image]);
    if (error) throw error;
    return <Canvas pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', left: 0, top: 0, width: box.width, height: box.height }}>
        {image ? <Image image={image} x={0} y={0} width={box.width} height={box.height} fit="fill" /> : null}
    </Canvas>;
});
