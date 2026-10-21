import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { composerTextToDoc, mapComposerDoc } from './composerTextDocMapping';
import { createComposerEditorExtensions } from './composerEditorSchema.web';
import type { ComposerEditorReference } from './composerEditorTypes';

const token = '[Auth](happier-ref:session:auth)';
function reference(start: number): ComposerEditorReference {
    return { ref: 'session:auth', kind: 'happier.session', label: 'Auth', token, start, end: start + token.length };
}

describe('composer text/document mapping', () => {
    it('renders only exact bound occurrences as atoms at the start, middle, end and beside each other', () => {
        const text = `${token} 😀 ${token}${token}`;
        const references = [reference(0), reference(token.length + 4), reference(token.length * 2 + 4)];
        expect(composerTextToDoc(text, references)).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [
            { type: 'composerReference', attrs: { ref: 'session:auth' } },
            { type: 'text', text: ' 😀 ' },
            { type: 'composerReference', attrs: { ref: 'session:auth' } },
            { type: 'composerReference', attrs: { ref: 'session:auth' } },
        ] }] });
        expect(composerTextToDoc(token, [])).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: token }] }] });
    });

    it('round trips CRLF and surrogate pairs, with no mapped offset strictly inside a chip', () => {
        const text = `😀\r\n${token}\n${token} end`;
        const references = [reference(4), reference(5 + token.length)];
        const schema = getSchema(createComposerEditorExtensions());
        const doc = schema.nodeFromJSON(composerTextToDoc(text, references));
        let index = 0;
        const mapping = mapComposerDoc(doc, () => references[index++]);
        expect(mapping.text).toBe(text);
        expect(mapping.references).toEqual(references);
        for (let offset = 0; offset <= text.length; offset++) {
            const snapped = mapping.positionToOffset(mapping.offsetToPosition(offset));
            const inside = references.find(reference => offset > reference.start && offset < reference.end);
            if (inside) expect([inside.start, inside.end]).toContain(snapped);
            else expect(snapped).toBe(offset);
        }
    });

    it('does not bind a stale range or an overlapping duplicate', () => {
        const json = composerTextToDoc(token, [{ ...reference(0), token: 'other' }, reference(0), reference(0)]);
        expect(json.content?.[0].content).toEqual([{ type: 'composerReference', attrs: { ref: 'session:auth' } }]);
    });
});
