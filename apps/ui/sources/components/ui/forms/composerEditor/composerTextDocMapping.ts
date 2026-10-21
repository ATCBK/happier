import type { JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { ComposerEditorReference } from './composerEditorTypes';

export function boundComposerEditorReferences(text: string, references: readonly ComposerEditorReference[]): ComposerEditorReference[] {
    let end = 0;
    return [...references].sort((a, b) => a.start - b.start).filter(reference => {
        if (reference.start < end || reference.start < 0 || reference.end <= reference.start
            || reference.end > text.length || text.slice(reference.start, reference.end) !== reference.token) return false;
        end = reference.end;
        return true;
    });
}

/** Exactly one paragraph; hard breaks preserve the source's UTF-16 offset space. */
export function composerTextToDoc(text: string, references: readonly ComposerEditorReference[]): JSONContent {
    const content: JSONContent[] = [];
    const appendText = (value: string) => {
        const lines = value.split('\n');
        for (let index = 0; index < lines.length; index++) {
            if (index > 0) content.push({ type: 'hardBreak' });
            if (lines[index]) content.push({ type: 'text', text: lines[index] });
        }
    };
    let cursor = 0;
    for (const reference of boundComposerEditorReferences(text, references)) {
        appendText(text.slice(cursor, reference.start));
        content.push({ type: 'composerReference', attrs: { ref: reference.ref } });
        cursor = reference.end;
    }
    appendText(text.slice(cursor));
    return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

type Segment = Readonly<{ start: number; end: number; from: number; to: number; atomic: boolean }>;

/** The only source↔editor mapping, also used for clipboard, selection and drop coordinates. */
export function mapComposerDoc(
    doc: ProseMirrorNode,
    readReference: (node: ProseMirrorNode, position: number) => ComposerEditorReference | undefined,
) {
    let text = '';
    const references: ComposerEditorReference[] = [];
    const segments: Segment[] = [];
    const append = (value: string, from: number, to: number, atomic = false) => {
        const start = text.length;
        text += value;
        segments.push({ start, end: text.length, from, to, atomic });
        return start;
    };
    doc.forEach((paragraph, paragraphOffset, paragraphIndex) => {
        if (paragraphIndex > 0) append('\n', paragraphOffset - 1, paragraphOffset + 1, true);
        paragraph.forEach((node, offset) => {
            const from = paragraphOffset + offset + 1;
            if (node.isText) append(node.text ?? '', from, from + node.nodeSize);
            else if (node.type.name === 'hardBreak') append('\n', from, from + 1);
            else if (node.type.name === 'composerReference') {
                const reference = readReference(node, from);
                if (!reference) return;
                const start = append(reference.token, from, from + node.nodeSize, true);
                references.push({ ...reference, start, end: text.length });
            }
        });
    });
    const offsetToPosition = (offset: number): number => {
        const value = Number.isFinite(offset) ? Math.max(0, Math.min(text.length, Math.trunc(offset))) : text.length;
        for (const segment of segments) {
            if (value > segment.end) continue;
            if (segment.atomic) return value - segment.start <= segment.end - value ? segment.from : segment.to;
            return segment.from + value - segment.start;
        }
        return Math.max(1, doc.content.size - 1);
    };
    const positionToOffset = (position: number): number => {
        for (const segment of segments) {
            if (position < segment.from) return segment.start;
            if (position > segment.to) continue;
            if (segment.atomic) return position - segment.from <= segment.to - position ? segment.start : segment.end;
            return segment.start + position - segment.from;
        }
        return text.length;
    };
    return { text, references, offsetToPosition, positionToOffset };
}
