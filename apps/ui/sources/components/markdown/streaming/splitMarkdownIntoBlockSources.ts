import { parser, GFM } from '@lezer/markdown';
import type { MarkdownBlock } from '../parseMarkdown';
import { containsMarkdownCode, readMarkdownCodeBlock, readMarkdownContainerBlock, type MarkdownContainerBlock } from './readMarkdownContainerBlock';
import { readIncompleteMarkdownBlockKind, type IncompleteMarkdownBlockKind } from './isIncompleteMarkdownBlockSource';
import { parseMarkdownSpans } from '../parseMarkdownSpans';
import { applyEnrichedMarkdownImagePolicy } from '../enriched/enrichedMarkdownLinkHandling';
import { isStreamingIncompleteLinkHref } from './streamingMarkdownRepairConfig';

const markdownBlockParser = parser.configure(GFM);

/** The same grammar owns rendering boundaries and display-to-source projections. */
export function parseMarkdownSyntax(markdown: string) {
    return markdownBlockParser.parse(markdown);
}

export type MarkdownBlockSource = Readonly<{
    index: number;
    source: string;
    sourceStart: number;
    blockType: string;
    referenceDefinitions: string;
    incompleteKind: IncompleteMarkdownBlockKind | null;
    container?: MarkdownContainerBlock;
    codeBlock?: MarkdownBlock;
    imageBlock?: Extract<MarkdownBlock, { type: 'image' }>;
}>;

function readImageParagraph(markdown: string, node: ReturnType<typeof parseMarkdownSyntax>['topNode']): Extract<MarkdownBlock, { type: 'image' }> | null {
    if (node.name !== 'Paragraph') return null;
    const image = node.firstChild;
    if (image?.name !== 'Image' || image.nextSibling || markdown.slice(node.from, image.from).trim() || markdown.slice(image.to, node.to).trim()) return null;
    const destination = image.getChild('URL');
    const marks = image.getChildren('LinkMark');
    if (!destination || marks.length < 2) return null;
    const imageDestination = markdown.slice(destination.from, destination.to).replace(/^<(.*)>$/, '$1').replace(/\\([\\()])/g, '$1');
    if (isStreamingIncompleteLinkHref(imageDestination)) return null;
    const altMarkdown = markdown.slice(marks[0]!.to, marks[1]!.from);
    const alt = parseMarkdownSpans(applyEnrichedMarkdownImagePolicy(altMarkdown), false).map(span => span.text).join('');
    return {
        type: 'image', alt,
        destination: imageDestination,
    };
}

/** One grammar owns boundaries for both grouped rendering and source-range measurement. */
export function splitMarkdownIntoBlockSources(markdown: string): MarkdownBlockSource[] {
    const tree = parseMarkdownSyntax(markdown);
    const definitions: string[] = [];
    tree.iterate({ enter(node) {
        if (node.name !== 'LinkReference') return;
        // Container markers are grammar tokens, not part of a global definition.
        let cursor = node.from;
        let definition = '';
        for (const marker of node.node.getChildren('QuoteMark')) {
            definition += markdown.slice(cursor, marker.from);
            cursor = marker.to;
        }
        definitions.push(definition + markdown.slice(cursor, node.to));
    } });
    const referenceDefinitions = definitions.join('\n');
    const sources: MarkdownBlockSource[] = [];
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        if (node.name === 'LinkReference') continue;
        const sourceStart = markdown.lastIndexOf('\n', node.from - 1) + 1;
        const source = markdown.slice(sourceStart, node.to);
        const imageBlock = readImageParagraph(markdown, node);
        sources.push({
            index: sources.length,
            source,
            sourceStart,
            blockType: node.name,
            referenceDefinitions,
            incompleteKind: readIncompleteMarkdownBlockKind(source),
            ...(imageBlock ? { imageBlock } : {}),
            ...((node.name === 'BulletList' || node.name === 'OrderedList' || node.name === 'Blockquote') && containsMarkdownCode(node)
                ? { container: readMarkdownContainerBlock(markdown, node, referenceDefinitions) } : null),
            ...(node.name === 'CodeBlock' ? { codeBlock: readMarkdownCodeBlock(markdown, node) } : null),
        });
    }
    return sources;
}
