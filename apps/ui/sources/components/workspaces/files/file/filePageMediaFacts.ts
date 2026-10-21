import type { ImageWellInfo } from '@/components/ui/media/ImageWell';
import type { FileViewerClass } from '@/scm/utils/filePresentation';
import { t } from '@/text';

import { formatFilePageBytes } from './FilePageStates';

/** What the player learns once it has loaded a recording: its length and, for a video, its frame. */
export type FilePageMediaInfo = Readonly<{ durationSeconds: number; width?: number; height?: number }>;

/** Playback time as a clock (`0:42`, `1:02:05`), shared by the audio row and the meta row. */
export function formatPlaybackTime(seconds: number): string {
    const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = String(total % 60).padStart(2, '0');
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/**
 * The meta row's facts for a picture, a document or a recording, written once there and never under the body
 * (lab FV4–FV6, P2 media facts): its pixels or frame, its kind (a PDF's page count stands for it), its length,
 * its size, then the integer scale a tiny picture is shown at. Facts the viewer has not learned yet are left out.
 */
export function resolveFilePageMediaFacts(input: Readonly<{
    viewer: FileViewerClass;
    sizeBytes: number | null;
    image?: ImageWellInfo | null;
    pdfPageCount?: number | null;
    media?: FilePageMediaInfo | null;
}>): string[] {
    const { image, media } = input;
    const frame = image ?? (media && typeof media.width === 'number' && typeof media.height === 'number' ? media : null);
    return [
        ...(frame ? [`${frame.width} × ${frame.height}`] : []),
        typeof input.pdfPageCount === 'number'
            ? t('files.viewer.pdfPageCount', { count: input.pdfPageCount })
            : t(input.viewer.labelKey as never) as string,
        ...(media && Number.isFinite(media.durationSeconds) && media.durationSeconds > 0 ? [formatPlaybackTime(media.durationSeconds)] : []),
        ...(typeof input.sizeBytes === 'number' ? [formatFilePageBytes(input.sizeBytes)] : []),
        ...(image && image.displayScale > 1 ? [t('files.viewer.shownAt', { scale: image.displayScale })] : []),
    ];
}
