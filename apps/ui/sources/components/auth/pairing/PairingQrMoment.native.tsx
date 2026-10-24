import * as React from 'react';
import { Animated, PixelRatio, View } from 'react-native';
import { Canvas, Picture, createPicture, type SkPicture } from '@shopify/react-native-skia';
import { paintNativeMomentCommands } from '@/components/atmosphere/momentPaint.native';
import { useNativeMomentEnvironment } from '@/components/atmosphere/useNativeMomentEnvironment';
import { useCanvasRenderState } from '@/components/atmosphere/useCanvasRenderState';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { createPairingQrMomentFrames } from './pairingQrMomentFrame';
import { selectQrMomentFrame, type QrMomentScene } from './pairingQrMomentTimeline';
import type { PairingQrMomentCanvasProps } from './pairingQrMoment.types';

export const PAIRING_QR_MOMENT_SUPPORTED = true;

/** Same event timeline and brand command stream as web; the native scene rests without a frame loop. */
export const PairingQrMomentCanvas = React.memo(function PairingQrMomentCanvas(props: PairingQrMomentCanvasProps & Readonly<{ scene: QrMomentScene }>) {
    const { size, scene, theme, reducedMotion, pairing, machines } = props;
    const dpr = PixelRatio.get();
    const env = useNativeMomentEnvironment(size, size, dpr);
    const state = useCanvasRenderState({ size: { width: size, height: size } });
    const build = React.useMemo(createPairingQrMomentFrames, []);
    const [pictures, setPictures] = React.useState<Readonly<{ current: SkPicture; previous: SkPicture | null }> | null>(null);
    const [opacity] = React.useState(() => new Animated.Value(0));
    const shown = React.useRef<SkPicture | null>(null);
    const latest = React.useRef({ props, env }); latest.current = { props, env };
    const envReady = env !== null;
    const mark = env?.mark;
    React.useEffect(() => {
        if (!envReady || !state.visible) return;
        let cancelled = false, frame = 0;
        let fade: Animated.CompositeAnimation | undefined;
        const step = () => {
            if (cancelled || !latest.current.env) return;
            const selection = selectQrMomentFrame(scene, performance.now(), { reducedMotion, pairing });
            if (selection.request) {
                const next = createPicture(canvas => paintNativeMomentCommands(canvas, build(selection.request!, latest.current.props, dpr), latest.current.env!), { width: size, height: size });
                const previous = reducedMotion ? shown.current : null;
                setPictures({ current: next, previous }); shown.current = next;
                if (previous) {
                    opacity.setValue(1);
                    fade = Animated.timing(opacity, { toValue: 0, duration: motionTokens.atmosphere.reducedCrossFadeMs, useNativeDriver: true });
                    fade.start(({ finished }) => { if (finished && !cancelled) setPictures(current => current?.current === next ? { current: next, previous: null } : current); });
                }
            }
            if (selection.animating) frame = requestAnimationFrame(step);
        };
        step();
        return () => { cancelled = true; cancelAnimationFrame(frame); fade?.stop(); };
    }, [scene, size, theme, reducedMotion, pairing, machines, dpr, envReady, mark, state.visible, build, opacity]);
    // Ownership follows committed pictures: an interrupted reduced fade cannot dispose a still-visible layer.
    const owned = React.useRef<readonly SkPicture[]>([]);
    React.useLayoutEffect(() => {
        const next = pictures ? [pictures.current, ...(pictures.previous ? [pictures.previous] : [])] : [];
        for (const picture of owned.current) if (!next.includes(picture)) picture.dispose();
        owned.current = next;
    }, [pictures]);
    React.useEffect(() => () => { owned.current.forEach(picture => picture.dispose()); owned.current = []; }, []);
    return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
        <Canvas style={{ width: size, height: size }}>{pictures ? <Picture picture={pictures.current} /> : null}</Canvas>
        {pictures?.previous ? <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, opacity }}>
            <Canvas style={{ width: size, height: size }}><Picture picture={pictures.previous} /></Canvas>
        </Animated.View> : null}
    </View>;
});
