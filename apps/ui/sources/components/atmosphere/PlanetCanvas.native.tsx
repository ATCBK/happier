import * as React from 'react';
import { PixelRatio } from 'react-native';
import { AlphaType, BlendMode, Canvas, ColorType, FilterMode, MipmapMode, Picture, Skia, TileMode, createPicture, useFont } from '@shopify/react-native-skia';
import { orderedFadeMask } from './orderedFadeMask';
import { createPlanetCanvasSceneCache, snapCanvasBox } from './planetCanvasScene';
import type { PlanetCanvasProps } from './planetCanvas.types';
import { paintNativePlanetScene } from './planetCanvasPaint.native';

export const PlanetCanvas = React.memo(function PlanetCanvas(props: PlanetCanvasProps) {
    const regular = useFont(require('@/assets/fonts/IBMPlexMono-Regular.ttf'), 12);
    const strong = useFont(require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'), 12);
    const dpr = props.options?.dpr ?? PixelRatio.get();
    const box = snapCanvasBox(props.width, props.height, dpr);
    const resolveScene = React.useMemo(createPlanetCanvasSceneCache, []);
    const scene = resolveScene(props, dpr);
    const fadeFrom = props.fade?.from, fadeTo = props.fade?.to;
    const fade = fadeFrom !== undefined && fadeTo !== undefined ? { from: fadeFrom, to: fadeTo } : null;
    const picture = React.useMemo(() => {
        if (scene.cells.length && (!regular || !strong)) return null;
        return createPicture(canvas => {
            const scale = props.mark ? props.width / (props.mark.size ?? 24) : 1;
            canvas.scale(scale, scale);
            if (fade) canvas.saveLayer();
            paintNativePlanetScene(canvas, scene, regular, strong, props.mark?.ink ?? props.ink);
            if (fade) {
                // The brand's ordered foot fade as an alpha mask, one lattice period wide and tiled across.
                const mask = orderedFadeMask(box.height, fade.from, fade.to, dpr);
                const image = Skia.Image.MakeImage({ width: mask.width, height: mask.height, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul },
                    Skia.Data.fromBytes(new Uint8Array(mask.rgba.buffer)), mask.width * 4);
                if (!image) throw new Error('Atmosphere fade mask could not be created');
                const matrix = Skia.Matrix(); matrix.scale(1 / dpr, 1 / dpr);
                const maskPaint = Skia.Paint(); maskPaint.setBlendMode(BlendMode.DstIn);
                maskPaint.setShader(image.makeShaderOptions(TileMode.Repeat, TileMode.Clamp, FilterMode.Nearest, MipmapMode.None, matrix));
                canvas.drawRect(Skia.XYWHRect(0, 0, box.width, box.height), maskPaint);
                canvas.restore(); maskPaint.dispose(); image.dispose();
            }
        }, { width: box.width, height: box.height });
    }, [box.height, box.width, dpr, fadeFrom, fadeTo, props.mark?.ink, props.ink, props.mark?.size, props.width, regular, scene, strong]);
    React.useEffect(() => { if (picture) props.onReady?.(); }, [picture, props.onReady]);
    React.useEffect(() => () => { picture?.dispose(); }, [picture]);
    return <Canvas pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={props.testID} style={[props.style, { width: box.width, height: box.height }]}>
        {picture ? <Picture picture={picture} /> : null}
    </Canvas>;
});
