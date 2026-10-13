/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import '@tiptap/markdown';

import { createMarkdownEditorExtensions } from '../createMarkdownEditorExtensions';
import { seedMarkdown } from '../seedMarkdown';

function createEditorFixture() {
    const scrollElement = document.createElement('div');
    const element = document.createElement('div');
    scrollElement.appendChild(element);
    document.body.appendChild(scrollElement);
    const editor = new Editor({ element, extensions: createMarkdownEditorExtensions(),
        content: 'Original long paragraph content', contentType: 'markdown' });
    editor.commands.setTextSelection({ from: 7, to: 12 });
    scrollElement.scrollTop = 84;
    scrollElement.scrollLeft = 9;
    return { editor, scrollElement };
}

describe('seedMarkdown', () => {
    it('preserves a real selection and scroll across content replacement and soft-break normalization', () => {
        const { editor, scrollElement } = createEditorFixture();
        try {
            seedMarkdown(editor, 'external update\nsecond line', { preserveViewState: true });
            expect(editor.state.selection).toMatchObject({ from: 7, to: 12 });
            expect(editor.state.doc.childCount).toBe(2);
            expect(editor.state.doc.child(0).textContent).toBe('external update');
            expect(editor.state.doc.child(1).textContent).toBe('second line');
            expect(scrollElement.scrollTop).toBe(84);
            expect(scrollElement.scrollLeft).toBe(9);
        } finally { editor.destroy(); scrollElement.remove(); }
    });

    it('clamps restored selection to the new document size', () => {
        const { editor, scrollElement } = createEditorFixture();
        try {
            seedMarkdown(editor, 'x', { preserveViewState: true });
            expect(editor.state.doc.textContent).toBe('x');
            // The text cursor ends before the paragraph's closing node boundary.
            const end = editor.state.doc.content.size - 1;
            expect(editor.state.selection).toMatchObject({ from: end, to: end });
            expect(editor.state.selection.$from.parent.inlineContent).toBe(true);
        } finally { editor.destroy(); scrollElement.remove(); }
    });
});
