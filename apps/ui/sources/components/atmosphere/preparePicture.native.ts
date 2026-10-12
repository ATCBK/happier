import { FilterMode, ImageFormat, MipmapMode, Skia } from '@shopify/react-native-skia';
import { createWorkletRuntime, runOnRuntimeAsync, type WorkletRuntime } from 'react-native-worklets';

let imageRuntime: WorkletRuntime | undefined;

/** Loaded on demand so Planet/None does not initialize the native image stack. */
export async function prepareNativePicture(encoded: string): Promise<string> {
    imageRuntime ??= createWorkletRuntime({ name: 'happier-atmosphere-images' });
    const api = Skia;
    const webp = ImageFormat.WEBP;
    const linear = FilterMode.Linear;
    const noMipmap = MipmapMode.None;
    // Skia's native encoder returns null on failure despite declaring string.
    const result: unknown = await runOnRuntimeAsync(imageRuntime, (source: string) => {
        'worklet';
        const input = api.Data.fromBase64(source);
        try {
            const image = api.Image.MakeImageFromEncoded(input);
            if (!image) throw new Error('Atmosphere picture could not be decoded');
            try {
                const scale = Math.min(1, 2560 / Math.max(image.width(), image.height()));
                const width = Math.max(1, Math.round(image.width() * scale));
                const height = Math.max(1, Math.round(image.height() * scale));
                // CPU raster surfaces can be created on the worker runtime;
                // GPU offscreen surfaces depend on the platform graphics context.
                const surface = api.Surface.Make(width, height);
                if (!surface) throw new Error('Atmosphere picture surface could not be allocated');
                try {
                    surface.getCanvas().drawImageRectOptions(image,
                        api.XYWHRect(0, 0, image.width(), image.height()),
                        api.XYWHRect(0, 0, width, height), linear, noMipmap);
                    surface.flush();
                    const output = surface.makeImageSnapshot();
                    try { return output.encodeToBase64(webp, 86); } finally { output.dispose(); }
                } finally { surface.dispose(); }
            } finally { image.dispose(); }
        } finally { input.dispose(); }
    }, encoded);
    if (typeof result !== 'string') throw new Error('Atmosphere picture could not be encoded as WebP');
    return `data:image/webp;base64,${result}`;
}
