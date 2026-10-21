import { thumbhash } from "./thumbhash";
import { loadSharp } from "./sharpRuntime";

/**
 * The one image publication owner.
 *
 * Every caller that publishes a public image goes through here, so decoding,
 * bounding, fitting, re-encoding, and thumbhash generation have a single
 * implementation. What it returns are the bytes that will actually be written
 * plus metadata describing *those* bytes: a caller must never publish one buffer
 * while advertising another buffer's dimensions or format.
 *
 * Re-encoding is also the boundary's security property. The published object is
 * produced from decoded pixels, so an unrelated payload appended to a valid
 * image is not carried forward and no source metadata survives implicitly.
 */

/** The canonical formats the publication encoder produces. */
export type ProcessedImageFormat = "png" | "jpeg";

/** WebP source admission is explicit; existing avatar/logo callers stay PNG/JPEG-only. */
export type ProcessImageSourceMimeType = "image/png" | "image/jpeg" | "image/webp";

/**
 * `contain` bounds the longest edge and preserves the aspect ratio. `cover`
 * centre-crops to a square, which is the deterministic server-side fit the Team
 * logo uses in place of an interactive crop editor.
 */
export type ProcessedImageFit = "contain" | "cover";

export type ProcessedImage = {
    /** The exact bytes to publish. */
    bytes: Buffer;
    format: ProcessedImageFormat;
    mimeType: "image/png" | "image/jpeg";
    /** The file extension matching `format`; a stored object must use it. */
    extension: "png" | "jpg";
    /** The published bytes' dimensions, not the source's. */
    width: number;
    height: number;
    thumbhash: string;
};

/**
 * The default decode budget, expressed as its real cost: the decoder expands to
 * raw RGBA at 4 bytes per pixel, so this is a 64 MiB working set. A compressed
 * byte count cannot bound that — a uniform 12000×12000 PNG is a few hundred
 * kilobytes on the wire and over half a gigabyte decoded — which is why the
 * pixel bound exists separately from any request-size limit.
 */
export const IMAGE_MAX_DECODE_PIXELS = (64 * 1024 * 1024) / 4;

/**
 * The default published edge. The largest surface that renders one of these
 * images is around 128 pt, which is 384 px on a 3× display; 512 keeps headroom
 * without publishing an original-resolution photograph.
 */
export const IMAGE_PUBLISHED_MAX_EDGE = 512;

/** Thumbhash accepts at most 100×100 and the encoding is defined for that box. */
const THUMBHASH_MAX_EDGE = 100;

export type ProcessImageOptions = Readonly<{
    fit?: ProcessedImageFit;
    maxEdge?: number;
    maxInputPixels?: number;
    /** Defaults to PNG/JPEG; prepared atmosphere callers explicitly admit WebP. */
    allowedSourceMimeTypes?: readonly ProcessImageSourceMimeType[];
    /** Explicit PNG output preserves reviewed pixels without another lossy encoding. */
    outputFormat?: ProcessedImageFormat;
    /**
     * When a caller received a declared upload MIME, validate it against the
     * decoder's source format in this same metadata pass. This is source
     * admission only; the published MIME may differ after canonical re-encode.
     */
    expectedSourceMimeType?: ProcessImageSourceMimeType;
}>;

export type ProcessImageRejection =
    | "undecodable"
    | "unsupported_format"
    | "source_mime_mismatch"
    | "too_many_pixels";

export type ProcessImageResult =
    | Readonly<{ ok: true; image: ProcessedImage }>
    | Readonly<{ ok: false; reason: ProcessImageRejection }>;

/**
 * Decode, bound, fit, and re-encode one image, reporting a typed rejection.
 *
 * Authenticated upload boundaries use this form: an invalid or oversized upload
 * is an ordinary user-visible outcome that must be answered with a precise
 * reason, not an exception mapped to a generic failure.
 */
export async function tryProcessImage(src: Buffer, options: ProcessImageOptions = {}): Promise<ProcessImageResult> {
    const sharp = await loadSharp();
    const maxInputPixels = options.maxInputPixels ?? IMAGE_MAX_DECODE_PIXELS;
    const maxEdge = options.maxEdge ?? IMAGE_PUBLISHED_MAX_EDGE;
    const fit = options.fit ?? "contain";

    let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
        // The header is parsed without the pixel limit precisely so an oversized
        // image can be reported as oversized. Enforcing the limit here instead
        // would collapse "too large to decode" into "not an image", which is the
        // wrong answer to give someone who submitted a real photograph.
        meta = await sharp(src, { limitInputPixels: false }).metadata();
    } catch {
        return { ok: false, reason: "undecodable" };
    }

    if (meta.format !== "png" && meta.format !== "jpeg" && meta.format !== "webp") {
        return { ok: false, reason: "unsupported_format" };
    }
    const sourceMimeType = meta.format === "png" ? "image/png" : meta.format === "jpeg" ? "image/jpeg" : "image/webp";
    const allowedSourceMimeTypes = options.allowedSourceMimeTypes ?? ["image/png", "image/jpeg"];
    if (!allowedSourceMimeTypes.includes(sourceMimeType)) return { ok: false, reason: "unsupported_format" };
    if (options.expectedSourceMimeType !== undefined && options.expectedSourceMimeType !== sourceMimeType) {
        return { ok: false, reason: "source_mime_mismatch" };
    }
    const sourceWidth = meta.width;
    const sourceHeight = meta.height;
    if (!sourceWidth || !sourceHeight) return { ok: false, reason: "undecodable" };
    // Checked explicitly as well as through the decoder limit: the header is read
    // before any pixel buffer is allocated, so the rejection happens up front and
    // does not depend on which stage the decoder chose to enforce its own limit.
    if (sourceWidth * sourceHeight > maxInputPixels) return { ok: false, reason: "too_many_pixels" };

    // Alpha decides the default output format: JPEG would flatten transparency
    // onto an invented background, and PNG would triple a photograph's size.
    // A reviewed picture copy can explicitly require lossless PNG instead.
    const outputFormat = options.outputFormat ?? (meta.hasAlpha === true ? "png" : "jpeg");

    // A phone photograph is very often stored unrotated with an EXIF
    // orientation tag, and re-encoding deliberately drops all source metadata —
    // so without applying the rotation first, the published image is sideways
    // while the client's own preview of the source bytes is upright. The
    // decoder's own oriented dimensions are used for the square crop, because
    // the shorter edge of a rotated portrait photograph is the other one.
    const oriented = meta.autoOrient ?? { width: sourceWidth, height: sourceHeight };
    const coverEdge = Math.min(maxEdge, oriented.width, oriented.height);

    const resized = fit === "cover"
        // Never upscale to reach the square: a smaller source is cropped to its
        // own shorter edge instead of being interpolated up to `maxEdge`.
        ? sharp(src, { limitInputPixels: maxInputPixels, autoOrient: true }).resize({
            width: coverEdge,
            height: coverEdge,
            fit: "cover",
            position: "centre",
        })
        : sharp(src, { limitInputPixels: maxInputPixels, autoOrient: true }).resize({
            width: maxEdge,
            height: maxEdge,
            fit: "inside",
            withoutEnlargement: true,
        });

    let bytes: Buffer;
    let width: number;
    let height: number;
    try {
        const encoded = await (outputFormat === "png" ? resized.png() : resized.jpeg()).toBuffer({ resolveWithObject: true });
        bytes = encoded.data;
        width = encoded.info.width;
        height = encoded.info.height;
    } catch {
        return { ok: false, reason: "undecodable" };
    }

    return {
        ok: true,
        image: {
            bytes,
            format: outputFormat,
            mimeType: outputFormat === "png" ? "image/png" : "image/jpeg",
            extension: outputFormat === "png" ? "png" : "jpg",
            width,
            height,
            // Derived from the published bytes so the placeholder a client renders
            // is a preview of what it is about to load, not of a discarded source.
            thumbhash: await renderThumbhash(bytes, maxInputPixels),
        },
    };
}

/**
 * The throwing form, for internal callers whose input is not user-submitted and
 * for whom an unreadable image is a genuine fault rather than an answer.
 */
export async function processImage(src: Buffer, options: ProcessImageOptions = {}): Promise<ProcessedImage> {
    const result = await tryProcessImage(src, options);
    if (!result.ok) throw new Error(`Unable to process image: ${result.reason}`);
    return result.image;
}

async function renderThumbhash(published: Buffer, maxInputPixels: number): Promise<string> {
    const sharp = await loadSharp();
    const { data, info } = await sharp(published, { limitInputPixels: maxInputPixels })
        .resize({ width: THUMBHASH_MAX_EDGE, height: THUMBHASH_MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return Buffer.from(thumbhash(info.width, info.height, data)).toString("base64");
}
