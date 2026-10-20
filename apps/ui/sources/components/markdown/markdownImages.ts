import type { MarkdownImageSource, MarkdownImageResolver } from '@happier-dev/plugin-ui/components';
import { splitMarkdownRenderSegments } from './rendering/splitMarkdownRenderSegments';
import type { MarkdownRenderSegment } from './rendering/markdownRenderSegmentTypes';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
export type { MarkdownImageSource, MarkdownImageResolver } from '@happier-dev/plugin-ui/components';

export type MarkdownDocumentImage = Readonly<{
    alt: string;
    destination: string;
    source: MarkdownImageSource;
    sourceStart: number;
}>;

export type MarkdownImageDocument = Readonly<{
    images: readonly MarkdownDocumentImage[];
    gallery: readonly MarkdownDocumentImage[];
    remoteImageCount: number;
}>;

export function buildMarkdownImageDocument(input: Readonly<{ markdown: string; images: MarkdownImageResolver; segments?: readonly MarkdownRenderSegment[] }>): MarkdownImageDocument {
    const images: MarkdownDocumentImage[] = [];
    for (const segment of input.segments ?? splitMarkdownRenderSegments({ markdown: input.markdown, streamingMode: 'static', imagesEnabled: true })) {
        if (segment.type !== 'special-block') continue;
        for (const block of segment.blocks) {
            if (block.type !== 'image') continue;
            images.push({ alt: block.alt, destination: block.destination, source: input.images.resolve(block.destination), sourceStart: segment.sourceStart });
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
