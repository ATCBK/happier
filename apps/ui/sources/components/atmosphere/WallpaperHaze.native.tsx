import * as React from 'react';
import { PixelRatio } from 'react-native';
import { Canvas, Image, useImage, type SkImage } from '@shopify/react-native-skia';
import type { BackdropCanvasProps } from './backdropCanvas.types';
import { backdropRenderRequest, backdropRequestKey } from './backdropRenderRequest';
import { renderNativeBackdrop, renderNativeWallpaperHaze } from './renderBackdrop.native';
import { useCanvasRenderState } from './useCanvasRenderState';
import { WALLPAPER_HAZE_LAYERS } from './wallpaperHaze';

/** Two blurred picture copies masked at the content column, prepared once off the UI thread. */
export function WallpaperHaze(props: Readonly<{ source: BackdropCanvasProps['source']; size: BackdropCanvasProps['size']; job: Omit<BackdropCanvasProps, 'source' | 'size'>; focus: { x: number; y: number } }>) {
    const quarter = { width: Math.max(2, Math.round(props.size.width / 4)), height: Math.max(2, Math.round(props.size.height / 4)) };
    const request = backdropRenderRequest({ source: props.source, size: quarter, ...props.job }, 1);
    const key = backdropRequestKey(request);
    const [uri, setUri] = React.useState<string | null>(null);
    const source = useImage(uri);
    const [image, setImage] = React.useState<SkImage | null>(null);
    const [error, setError] = React.useState<unknown>(null);
    const dpr = PixelRatio.get();
    const state = useCanvasRenderState(props.size);
    const latest = React.useRef(request); latest.current = request;
    React.useEffect(() => {
        if (!state.visible) return;
        let live = true;
        void renderNativeBackdrop(latest.current).then(next => { if (live) setUri(next); }, error => { if (live) setError(error); });
        return () => { live = false; };
    }, [key, props.source, state.visible]);
    const { width, height } = props.size;
    const { x, y } = props.focus;
    React.useEffect(() => {
        if (!source || !state.visible) return;
        let live = true;
        void renderNativeWallpaperHaze(source, { width, height, x, y, dpr, layers: WALLPAPER_HAZE_LAYERS }).then(next => {
            if (live) setImage(next); else next.dispose();
        }, error => { if (live) setError(error); });
        return () => { live = false; };
    }, [source, width, height, x, y, dpr, state.visible]);
    React.useEffect(() => () => image?.dispose(), [image]);
    if (error) throw error;
    return <Canvas pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', left: 0, top: 0, width, height }}>
        {image ? <Image image={image} x={0} y={0} width={width} height={height} fit="fill" /> : null}
    </Canvas>;
}
