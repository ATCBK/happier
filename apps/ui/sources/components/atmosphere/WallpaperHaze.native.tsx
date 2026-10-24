import * as React from 'react';
import { PixelRatio } from 'react-native';
import { Canvas, Image, useImage, type SkImage } from '@shopify/react-native-skia';
import type { BackdropCanvasProps } from './backdropCanvas.types';
import { backdropRenderRequest, backdropRequestKey } from './backdropRenderRequest';
import { NATIVE_TONE_SIDE, readNativePicturePixels, renderNativeBackdrop, renderNativeWallpaperHaze } from './renderBackdrop.native';
import { useCanvasRenderState } from './useCanvasRenderState';
import type { WallpaperHaze as WallpaperHazeComposition } from './wallpaperHaze';

/** Two blurred picture copies masked at the content column, prepared once off the UI thread. */
export function WallpaperHaze(props: Readonly<{ source: BackdropCanvasProps['source']; size: BackdropCanvasProps['size']; job: Omit<BackdropCanvasProps, 'source' | 'size'>; focus: { x: number; y: number }; haze: WallpaperHazeComposition; onRendered?: BackdropCanvasProps['onRendered'] }>) {
    const state = useCanvasRenderState({ size: props.size });
    const resizing = state.geometry.size.width !== props.size.width || state.geometry.size.height !== props.size.height;
    const quarter = { width: Math.max(2, Math.round(state.geometry.size.width / 4)), height: Math.max(2, Math.round(state.geometry.size.height / 4)) };
    const request = backdropRenderRequest({ source: props.source, size: quarter, ...props.job }, 1);
    const key = backdropRequestKey(request);
    const [uri, setUri] = React.useState<string | null>(null);
    const source = useImage(uri);
    const [image, setImage] = React.useState<SkImage | null>(null);
    const [error, setError] = React.useState<unknown>(null);
    const dpr = PixelRatio.get();
    const latest = React.useRef(request); latest.current = request;
    React.useEffect(() => {
        if (!state.visible || resizing) return;
        let live = true;
        void renderNativeBackdrop(latest.current).then(next => { if (live) setUri(next); }, error => { if (live) setError(error); });
        return () => { live = false; };
    }, [key, props.source, state.visible, resizing]);
    const { width, height } = state.geometry.size;
    const { x, y } = props.focus;
    // The composition is derived each render; its content, not its identity, decides a redraw.
    const composition = React.useRef(props.haze); composition.current = props.haze;
    const compositionKey = JSON.stringify(props.haze);
    const rendered = React.useRef(props.onRendered); rendered.current = props.onRendered;
    // Head lines stand on this render: the atmosphere measures its tone as the web does from its canvas.
    React.useEffect(() => {
        if (!source || !rendered.current) return;
        let live = true;
        void readNativePicturePixels(source, NATIVE_TONE_SIDE).then(pixels => { if (live) rendered.current?.(pixels); }, () => {});
        return () => { live = false; };
    }, [source]);
    React.useEffect(() => {
        if (!source || !state.visible || resizing) return;
        let live = true;
        void renderNativeWallpaperHaze(source, { width, height, x, y, dpr, ...composition.current }).then(next => {
            if (live) setImage(next); else next.dispose();
        }, error => { if (live) setError(error); });
        return () => { live = false; };
    }, [source, width, height, x, y, dpr, compositionKey, state.visible, resizing]);
    React.useEffect(() => () => image?.dispose(), [image]);
    if (error) throw error;
    return <Canvas pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', left: 0, top: 0, width, height }}>
        {image ? <Image image={image} x={0} y={0} width={width} height={height} fit="fill" /> : null}
    </Canvas>;
}
