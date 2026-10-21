import { describe, expect, it } from 'vitest';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { planComposerReferenceInsertion } from './composerReferenceInsertion';

const reference = { label: 'a.ts', ref: 'file:src/a.ts', kind: 'happier.file' };
const token = formatInlineReferenceTokenV1(reference);

describe('planComposerReferenceInsertion', () => {
    it('replaces the complete active word and binds only the inline token', () => {
        expect(planComposerReferenceInsertion({
            snapshot: { text: 'open @src now', references: [], selection: { start: 7, end: 7 } },
            reference, at: { kind: 'activeWord', range: { start: 5, end: 9 } },
        })).toEqual([
            { kind: 'text.replaceRange', range: { start: 5, end: 9 }, text: token },
            { kind: 'reference.insert', reference: { ...reference, token, start: 5, end: 5 + token.length } },
        ]);
    });

    it('snaps an offset to the nearer bound-token edge and adds only missing spaces', () => {
        const existing = { ...reference, token, start: 1, end: 1 + token.length };
        expect(planComposerReferenceInsertion({
            snapshot: { text: `x${token}y`, references: [existing] },
            reference, at: { kind: 'offset', offset: 2 },
        })).toEqual([
            { kind: 'text.insert', position: { offset: 1 }, text: ` ${token} ` },
            { kind: 'reference.insert', reference: { ...reference, token, start: 2, end: 2 + token.length } },
        ]);
        expect(planComposerReferenceInsertion({ snapshot: { text: `x${token}y`, references: [existing] },
            reference, at: { kind: 'offset', offset: existing.end - 1 } })).toEqual([
            { kind: 'text.insert', position: { offset: existing.end }, text: ` ${token} ` },
            { kind: 'reference.insert', reference: { ...reference, token, start: existing.end + 1, end: existing.end + 1 + token.length } },
        ]);
    });

    it('uses the selection or the end for caret insertion, preserving punctuation boundaries', () => {
        expect(planComposerReferenceInsertion({ snapshot: { text: '(old)', selection: { start: 1, end: 4 }, references: [] },
            reference, at: { kind: 'caret' } })[0]).toEqual({ kind: 'text.replaceRange', range: { start: 1, end: 4 }, text: token });
        expect(planComposerReferenceInsertion({ snapshot: { text: 'open', references: [] }, reference, at: { kind: 'caret' } })[0])
            .toEqual({ kind: 'text.insert', position: { offset: 4 }, text: ` ${token} ` });
    });

    it('leaves a word boundary after a reference that ends the text, so the next word is never glued to it', () => {
        expect(planComposerReferenceInsertion({
            snapshot: { text: 'fix it the way @c2', references: [], selection: { start: 18, end: 18 } },
            reference, at: { kind: 'activeWord', range: { start: 15, end: 18 } },
        })[0]).toEqual({ kind: 'text.replaceRange', range: { start: 15, end: 18 }, text: `${token} ` });
    });
});
