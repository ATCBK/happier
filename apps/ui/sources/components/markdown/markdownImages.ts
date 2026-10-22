import type { MarkdownImageSource, MarkdownImageResolver } from '@happier-dev/plugin-ui/components';
import { splitMarkdownRenderSegments } from './rendering/splitMarkdownRenderSegments';
import type { MarkdownRenderSegment } from './rendering/markdownRenderSegmentTypes';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { createImagePreviewAcquisition } from '@/components/ui/media/imagePreviewCache';
export type { MarkdownImageSource, MarkdownImageResolver } from '@happier-dev/plugin-ui/components';

export type MarkdownDocumentImage = Readonly<{
    alt: string;
    destination: string;
    source: MarkdownImageSource;
    sourceStart: number;
    /** The inline image and this document's frozen stage gallery admit the same byte read. */
    acquisitionKey: string;
}>;

export type MarkdownImageDocument = Readonly<{
    images: readonly MarkdownDocumentImage[];
    gallery: readonly MarkdownDocumentImage[];
    remoteImageCount: number;
}>;

export function buildMarkdownImageDocument(input: Readonly<{ markdown: string; images: MarkdownImageResolver; segments?: readonly MarkdownRenderSegment[]; acquisitionKey?: string }>): MarkdownImageDocument {
    const images: MarkdownDocumentImage[] = [];
    const acquisitionKey = input.acquisitionKey ?? createImagePreviewAcquisition();
    for (const segment of input.segments ?? splitMarkdownRenderSegments({ markdown: input.markdown, streamingMode: 'static', imagesEnabled: true })) {
        if (segment.type !== 'special-block') continue;
        for (const block of segment.blocks) {
            if (block.type !== 'image') continue;
            const source = input.images.resolve(block.destination);
            images.push({ alt: block.alt, destination: block.destination, source, sourceStart: segment.sourceStart,
                acquisitionKey: JSON.stringify([acquisitionKey, source.kind, source.kind === 'workspace' ? source.path
                    : source.kind === 'remote' ? source.url : block.destination]) });
        }
    }
    return {
        images,
        gallery: images.filter(image => {
            if (image.source.kind === 'remote') return input.images.remoteLoaded;
            if (image.source.kind !== 'workspace') return false;
            const kind = resolveFileViewerKind({ path: image.source.path }).kind;
            return kind === 'image' || kind === 'svg';
        }),
        remoteImageCount: images.filter(image => image.source.kind === 'remote').length,
    };
}
