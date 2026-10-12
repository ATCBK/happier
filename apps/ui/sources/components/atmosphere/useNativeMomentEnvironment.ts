import { useFont, useImage } from '@shopify/react-native-skia';

/** The same shipped typography faces and mark used by the web moment painter. */
export function useNativeMomentEnvironment(w: number, h: number, dpr: number, onError?: (error: Error) => void) {
    const mono = useFont(require('@/assets/fonts/IBMPlexMono-Regular.ttf'), 12, onError);
    const monoStrong = useFont(require('@/assets/fonts/IBMPlexMono-SemiBold.ttf'), 12, onError);
    const sans = useFont(require('@/assets/fonts/Inter-Regular.ttf'), 12, onError);
    const sansMedium = useFont(require('@/assets/fonts/Inter-Medium.ttf'), 12, onError);
    const sansStrong = useFont(require('@/assets/fonts/Inter-SemiBold.ttf'), 12, onError);
    const mark = useImage(require('@/assets/images/logo-black.png'));
    return mono && monoStrong && sans && sansMedium && sansStrong ? { w, h, dpr, mono, monoStrong, sans, sansMedium, sansStrong, mark } : null;
}
