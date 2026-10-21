import { FilterMode, ImageFormat, MipmapMode, Skia } from '@shopify/react-native-skia';
import { createWorkletRuntime, runOnRuntimeAsync, type WorkletRuntime } from 'react-native-worklets';
import { ATMOSPHERE_PICTURE_MAX_EDGE } from '@happier-dev/brand/atmosphere';
import type { PicturePreparationOptions } from './pictureStore.types';

let imageRuntime: WorkletRuntime | undefined;

/** Loaded on demand so Planet/None does not initialize the native image stack. */
export async function prepareNativePicture(encoded: string, options?: PicturePreparationOptions): Promise<string> {
    imageRuntime ??= createWorkletRuntime({ name: 'happier-atmosphere-images' });
    const api = Skia;
    const format = options?.format === 'png' ? ImageFormat.PNG : ImageFormat.WEBP;
    const linear = FilterMode.Linear;
    const noMipmap = MipmapMode.None;
    const maxEdge = ATMOSPHERE_PICTURE_MAX_EDGE;
    // Skia's native encoder returns null on failure despite declaring string.
    const result: unknown = await runOnRuntimeAsync(imageRuntime, (source: string) => {
        'worklet';
        const input = api.Data.fromBase64(source);
        try {
            const image = api.Image.MakeImageFromEncoded(input);
            if (!image) throw new Error('Atmosphere picture could not be decoded');
            try {
                const scale = Math.min(1, maxEdge / Math.max(image.width(), image.height()));
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
                    try { return output.encodeToBase64(format, 86); } finally { output.dispose(); }
                } finally { surface.dispose(); }
            } finally { image.dispose(); }
        } finally { input.dispose(); }
    }, encoded);
    if (typeof result !== 'string') throw new Error('Atmosphere picture could not be encoded');
    return `data:image/${options?.format === 'png' ? 'png' : 'webp'};base64,${result}`;
}
