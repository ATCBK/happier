import type { parser } from '@lezer/markdown';
import type { MarkdownBlock } from '../parseMarkdown';
import { parseMarkdownBlockContent, parseMarkdownCodeSources, type MarkdownCodeSource } from '../parseMarkdownBlock';
import { parseMarkdownSpans } from '../parseMarkdownSpans';

type SyntaxNode = ReturnType<typeof parser.parse>['topNode'];

export type MarkdownContainerBlock = Readonly<{ sourceStart: number }> & (
    | Readonly<{ type: 'code'; block: MarkdownBlock; sourceOffsets: readonly number[] }>
    | Readonly<{ type: 'prose'; markdown: string; sourceOffsets: readonly number[] }>
    | Readonly<{ type: 'quote'; children: readonly MarkdownContainerBlock[] }>
    | Readonly<{ type: 'list'; items: readonly Readonly<{
        sourceStart: number;
        marker: string;
        checked?: boolean;
        label?: string;
        children: readonly MarkdownContainerBlock[];
    }>[] }>
);

export function containsMarkdownCode(node: SyntaxNode): boolean {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true;
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (containsMarkdownCode(child)) return true;
    }
    return false;
}

export function readMarkdownCodeSource(markdown: string, node: SyntaxNode): Readonly<{ block: MarkdownBlock; sourceOffsets: readonly number[] }> {
    if (node.name === 'FencedCode') {
        // The incumbent parser owns fence indentation, language and diagram policy.
        const source = readProseSource(markdown, node);
        const parsed = parseMarkdownBlockContent(source.text, { includeCodeSources: true });
        const block = parsed.blocks[0];
        if (!block || (block.type !== 'code-block' && block.type !== 'mermaid')) {
            throw new Error('Markdown grammar produced a code fence without a code block');
        }
        const projection = parsed.codeSources.get(0)!;
        const sourceOffsets = projection.sourceOffsets.map(offset => source.sourceOffsets[offset]!);
        return { block, sourceOffsets };
    }
    let content = '';
    const sourceOffsets: number[] = [];
    let previousEnd: number | null = null;
    for (const text of node.getChildren('CodeText')) {
        if (previousEnd !== null) {
            for (let index = previousEnd; index < text.from; index++) {
                if (markdown[index] === '\n' || markdown[index] === '\r') {
                    content += markdown[index];
                    sourceOffsets.push(index);
                }
            }
        }
        content += markdown.slice(text.from, text.to);
        for (let index = text.from; index < text.to; index++) sourceOffsets.push(index);
        previousEnd = text.to;
    }
    return { block: { type: 'code-block', content, language: null }, sourceOffsets };
}

/** Custom options and fences share the incumbent parser; indented code is grammar-owned. */
export function readMarkdownSpecialCodeSources(markdown: string, node: SyntaxNode | null): ReadonlyMap<number, MarkdownCodeSource> {
    if (node?.name === 'CodeBlock') {
        const projection = readMarkdownCodeSource(markdown, node);
        if (projection.block.type !== 'code-block') throw new Error('Indented Markdown code did not produce a code block');
        return new Map([[0, { text: projection.block.content, sourceOffsets: projection.sourceOffsets,
            sourceEnds: projection.sourceOffsets.map(offset => offset + 1) }]]);
    }
    return parseMarkdownCodeSources(markdown);
}

export function readMarkdownCodeBlock(markdown: string, node: SyntaxNode): MarkdownBlock {
    return readMarkdownCodeSource(markdown, node).block;
}

/** Decontainerize grammar-owned leaves while retaining their original UTF-16 coordinates. */
function readProseSource(markdown: string, node: SyntaxNode): Readonly<{ text: string; sourceOffsets: readonly number[] }> {
    const start = markdown.lastIndexOf('\n', node.from - 1) + 1;
    const prefix = markdown.slice(start, node.from).replace(/> ?/g, '');
    const indent = Array.from(prefix).reduce((column, character) => character === '\t' ? column + 4 - column % 4 : column + 1, 0);
    const taskMarker = node.getChild('TaskMarker');
    let cursor = taskMarker ? taskMarker.to + (markdown[taskMarker.to] === ' ' ? 1 : 0) : node.from;
    let source = '';
    const offsets: number[] = [];
    const append = (from: number, to: number) => {
        source += markdown.slice(from, to);
        for (let index = from; index < to; index++) offsets.push(index);
    };
    for (const marker of node.getChildren('QuoteMark')) {
        append(cursor, marker.from);
        cursor = marker.to + (markdown[marker.to] === ' ' ? 1 : 0);
    }
    append(cursor, node.to);
    let text = '';
    const sourceOffsets: number[] = [];
    let lineStart = 0;
    source.split('\n').forEach((line, index) => {
        let removed = 0;
        let column = 0;
        if (index > 0) {
            while (removed < line.length && column < indent) {
                if (line[removed] === ' ') column++;
                else if (line[removed] === '\t') column += 4 - column % 4;
                else break;
                removed++;
            }
        }
        const padding = Math.max(0, column - indent);
        text += ' '.repeat(padding) + line.slice(removed);
        for (let count = 0; count < padding; count++) sourceOffsets.push(offsets[lineStart + removed - 1]!);
        for (let offset = lineStart + removed; offset < lineStart + line.length; offset++) sourceOffsets.push(offsets[offset]!);
        if (lineStart + line.length < source.length) {
            text += '\n';
            sourceOffsets.push(offsets[lineStart + line.length]!);
        }
        lineStart += line.length + 1;
    });
    return { text, sourceOffsets };
}

function readProse(markdown: string, node: SyntaxNode): string {
    return readProseSource(markdown, node).text;
}

export function readMarkdownContainerBlock(markdown: string, node: SyntaxNode, referenceDefinitions: string): MarkdownContainerBlock {
    const sourceStart = node.from;
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        return { type: 'code', sourceStart, ...readMarkdownCodeSource(markdown, node) };
    }
    const readChildren = (parent: SyntaxNode) => {
        const children: MarkdownContainerBlock[] = [];
        for (let child = parent.firstChild; child; child = child.nextSibling) {
            if (child.name === 'QuoteMark' || child.name === 'ListMark' || child.name === 'LinkReference') continue;
            children.push(readMarkdownContainerBlock(markdown, child, referenceDefinitions));
        }
        return children;
    };
    if (node.name === 'Blockquote') return { type: 'quote', sourceStart, children: readChildren(node) };
    if (node.name === 'BulletList' || node.name === 'OrderedList') {
        const ordered = node.name === 'OrderedList';
        const items = node.getChildren('ListItem');
        const firstMarker = items[0]?.getChild('ListMark');
        const firstNumber = firstMarker ? Number.parseInt(markdown.slice(firstMarker.from, firstMarker.to), 10) : 1;
        return {
            type: 'list', sourceStart,
            items: items.map((item, index) => {
                const taskNode = item.getChild('Task');
                const task = taskNode?.getChild('TaskMarker');
                return {
                    sourceStart: item.from,
                    marker: ordered ? `${firstNumber + index}.` : '•',
                    checked: task ? markdown.slice(task.from, task.to).toLowerCase() === '[x]' : undefined,
                    label: task && taskNode ? parseMarkdownSpans(readProse(markdown, taskNode), true).map(span => span.text).join('') : undefined,
                    children: readChildren(item),
                };
            }),
        };
    }
    const source = readProseSource(markdown, node);
    const definitions = referenceDefinitions ? `${referenceDefinitions}\n\n` : '';
    return { type: 'prose', sourceStart, markdown: definitions + source.text, sourceOffsets: [...Array<number>(definitions.length).fill(sourceStart), ...source.sourceOffsets] };
}
