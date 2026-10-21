import { Editor, Extension, type NodeViewRenderer } from '@tiptap/core';
import { Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, TextSelection, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { INLINE_REFERENCE_ATTACHMENT_SCHEME_V1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { parseMentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { reconcileStructuredInputMentionsWithTextChange } from '@/components/sessions/agentInput/structuredInputMentions';
import { createComposerEditorExtensions } from './composerEditorSchema.web';
import { boundComposerEditorReferences, composerTextToDoc, mapComposerDoc } from './composerTextDocMapping';
import type { ComposerEditorDecoration, ComposerEditorReference, ComposerEditorSelection } from './composerEditorTypes';

export type ComposerEditorDocument = Readonly<{
    text: string;
    references: readonly ComposerEditorReference[];
    selection: ComposerEditorSelection;
}>;

export type ComposerChipRenderer = (host: HTMLElement, reference: ComposerEditorReference, selected: boolean, remove: () => void) => Readonly<{
    update: (reference: ComposerEditorReference, selected: boolean) => void;
    destroy: () => void;
}>;

export type ComposerEditorControllerOptions = Readonly<{
    text: string;
    references?: readonly ComposerEditorReference[];
    decorations?: readonly ComposerEditorDecoration[];
    attachmentIds?: readonly string[];
    editable?: boolean;
    onChange?: (document: ComposerEditorDocument) => void;
    onSelection?: (document: ComposerEditorDocument) => void;
    onKeyDown?: (event: KeyboardEvent, document: ComposerEditorDocument) => boolean;
    onPasteFiles?: (event: ClipboardEvent) => boolean;
    onFocus?: () => void;
    onBlur?: () => void;
    onCaretChange?: () => void;
    onOpenLink?: (url: string) => void;
    renderChip?: ComposerChipRenderer;
}>;

function drawDropCaret(): HTMLElement {
    const caret = document.createElement('span');
    caret.setAttribute('data-composer-drop-caret', '');
    caret.setAttribute('aria-hidden', 'true');
    return caret;
}

/** Owns editor transactions; bindings stay on node identity across steps and undo. */
export function createComposerEditorController(element: HTMLElement, initial: ComposerEditorControllerOptions) {
    let options = initial;
    let applyingExternal = false;
    let composing = false;
    let compositionText: string | null = null;
    let deferred: ComposerEditorControllerOptions | null = null;
    let dropOffset: number | null = null;
    let mounted = false;
    let previousAttachmentIds = new Set(initial.attachmentIds ?? []);
    const removedAttachmentIds = new Set<string>();
    const bindings = new WeakMap<ProseMirrorNode, ComposerEditorReference>();
    const chipRefreshers = new Set<() => void>();
    const mapping = (doc = editor.state.doc) => mapComposerDoc(doc, node => bindings.get(node));
    const read = (): ComposerEditorDocument => {
        const current = mapping();
        const selection = editor.state.selection;
        return { text: current.text, references: current.references,
            selection: { start: current.positionToOffset(selection.from), end: current.positionToOffset(selection.to) } };
    };
    const isRemovedAttachment = (node: ProseMirrorNode) => {
        const reference = bindings.get(node);
        if (!reference) return false;
        const parsed = parseMentionRefV1(reference.ref);
        return parsed?.scheme === INLINE_REFERENCE_ATTACHMENT_SCHEME_V1 && removedAttachmentIds.has(parsed.opaque);
    };
    const nodeView: NodeViewRenderer = ({ node: initialNode, getPos }) => {
        let node = initialNode;
        let selected = false;
        const dom = document.createElement('span');
        dom.contentEditable = 'false';
        dom.setAttribute('data-composer-chip', '');
        // A chip placed while the person is composing settles in; a loaded draft's chips arrive still.
        if (mounted && !editor.isDestroyed && editor.view.hasFocus()) {
            dom.setAttribute('data-entering', '');
            dom.addEventListener('animationend', () => dom.removeAttribute('data-entering'), { once: true });
        }
        dom.setAttribute('role', 'img');
        let rendered: ReturnType<ComposerChipRenderer> | undefined;
        const remove = () => {
            const position = getPos();
            if (position === undefined || editor.isDestroyed) return;
            const current = editor.state.doc.nodeAt(position);
            if (current !== node) return;
            editor.view.dispatch(editor.state.tr.delete(position, position + node.nodeSize).scrollIntoView());
            editor.view.focus();
        };
        const refresh = () => {
            const reference = bindings.get(node);
            if (!reference) return;
            dom.setAttribute('aria-label', reference.accessibilityLabel ?? reference.label);
            if (options.renderChip) {
                if (rendered) rendered.update(reference, selected);
                else rendered = options.renderChip(dom, reference, selected, remove);
            } else dom.textContent = reference.label;
        };
        chipRefreshers.add(refresh);
        refresh();
        return {
            dom,
            update: next => { if (next.type !== node.type) return false; node = next; refresh(); return true; },
            selectNode: () => { selected = true; dom.setAttribute('data-selected', 'true'); refresh(); },
            deselectNode: () => { selected = false; dom.removeAttribute('data-selected'); refresh(); },
            ignoreMutation: () => true,
            destroy: () => { chipRefreshers.delete(refresh); rendered?.destroy(); },
        };
    };
    const presentation = Extension.create({
        name: 'composerPresentation',
        addProseMirrorPlugins() {
            return [new Plugin({
                props: {
                    decorations(state) {
                        const current = mapping(state.doc);
                        const decorations: Decoration[] = [];
                        for (const entry of options.decorations ?? []) {
                            const from = current.offsetToPosition(entry.start);
                            const to = current.offsetToPosition(entry.end);
                            if (from >= to) continue;
                            const treatment = typeof entry.treatment === 'string' ? entry.treatment : entry.treatment.kind;
                            decorations.push(Decoration.inline(from, to, {
                                'data-composer-decoration': treatment,
                                ...(entry.label ? { title: entry.label, 'aria-description': entry.label } : {}),
                            }));
                        }
                        // A range selection paints the chips it covers like the text around them.
                        if (!state.selection.empty && !(state.selection instanceof NodeSelection)) {
                            const { from, to } = state.selection;
                            state.doc.nodesBetween(from, to, (node, position) => {
                                if (node.type.name === 'composerReference' && position >= from && position + node.nodeSize <= to) {
                                    decorations.push(Decoration.node(position, position + node.nodeSize, { 'data-in-selection': '' }));
                                }
                            });
                        }
                        // A keyed widget keeps its node across unrelated updates, so the caret's fade-in plays once.
                        if (dropOffset !== null) decorations.push(Decoration.widget(current.offsetToPosition(dropOffset), drawDropCaret, { key: 'composer-drop-caret' }));
                        return DecorationSet.create(state.doc, decorations);
                    },
                },
                appendTransaction(transactions, _previous, state) {
                    if (!transactions.some(transaction => transaction.docChanged)) return null;
                    const removals: Array<{ from: number; to: number }> = [];
                    state.doc.descendants((node, position) => {
                        if (node.type.name === 'composerReference' && isRemovedAttachment(node)) removals.push({ from: position, to: position + node.nodeSize });
                    });
                    if (removals.length === 0) return null;
                    const transaction = state.tr.setMeta('addToHistory', false);
                    for (const range of removals.reverse()) transaction.delete(range.from, range.to);
                    return transaction;
                },
            })];
        },
    });
    const insertPlainText = (text: string) => {
        const content = editor.schema.nodeFromJSON(composerTextToDoc(text, [])).firstChild!.content;
        editor.view.dispatch(editor.state.tr.replaceSelection(new Slice(content, 0, 0)).scrollIntoView());
    };
    const clipboard = (event: ClipboardEvent, cut: boolean) => {
        if (composing || editor.view.composing || !event.clipboardData) return false;
        const current = read();
        const { start, end } = current.selection;
        if (start === end) return false;
        let text = current.text.slice(start, end);
        for (const reference of [...current.references].reverse()) {
            if (reference.start < start || reference.end > end) continue;
            text = text.slice(0, reference.start - start) + (reference.readableMarker ?? reference.label)
                + text.slice(reference.end - start);
        }
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
        if (cut && options.editable !== false) editor.view.dispatch(editor.state.tr.deleteSelection().scrollIntoView());
        return true;
    };
    const editor = new Editor({
        element,
        extensions: [...createComposerEditorExtensions(nodeView), presentation],
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
        editable: initial.editable !== false,
        injectCSS: false,
        editorProps: {
            attributes: { 'data-happier-text-input': 'true' },
            handleKeyDown(_view, event) {
                if (composing || editor.view.composing || event.isComposing || event.keyCode === 229) return false;
                if (options.onKeyDown?.(event, read())) return true;
                if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight')
                    && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
                    const { selection, tr } = editor.state;
                    if (selection instanceof NodeSelection && selection.node.type.name === 'composerReference') {
                        const position = event.key === 'ArrowLeft' ? selection.from : selection.to;
                        editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, position)));
                        return true;
                    }
                    if (selection.empty) {
                        const node = event.key === 'ArrowLeft' ? selection.$head.nodeBefore : selection.$head.nodeAfter;
                        if (node?.type.name === 'composerReference') {
                            const position = selection.head + (event.key === 'ArrowLeft' ? -node.nodeSize : node.nodeSize);
                            editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, position)));
                            return true;
                        }
                    }
                }
                if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
                const { selection, tr } = editor.state;
                if (selection instanceof NodeSelection && selection.node.type.name === 'composerReference') {
                    editor.view.dispatch(tr.deleteSelection().scrollIntoView());
                    return true;
                }
                if (!selection.empty) return false;
                const neighbor = event.key === 'Backspace' ? selection.$from.nodeBefore : selection.$from.nodeAfter;
                if (neighbor?.type.name !== 'composerReference') return false;
                const from = event.key === 'Backspace' ? selection.from - neighbor.nodeSize : selection.from;
                if (event.key === 'Backspace') editor.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, from)));
                else editor.view.dispatch(tr.delete(from, from + neighbor.nodeSize).scrollIntoView());
                return true;
            },
            handlePaste(_view, event) {
                if (options.onPasteFiles?.(event)) return true;
                if (!event.clipboardData || options.editable === false) return false;
                insertPlainText(event.clipboardData.getData('text/plain'));
                event.preventDefault();
                return true;
            },
            handleDrop: () => true,
            handleDOMEvents: {
                copy: (_view, event) => clipboard(event, false),
                cut: (_view, event) => clipboard(event, true),
                compositionstart: () => { composing = true; compositionText = read().text; return false; },
                compositionend: () => {
                    composing = false;
                    // The browser's final input mutation belongs to ProseMirror first.
                    queueMicrotask(() => {
                        if (editor.isDestroyed) return;
                        if (deferred) {
                            const next = deferred;
                            deferred = null;
                            const current = read();
                            update(next.text === compositionText
                                ? { ...next, text: current.text, references: current.references }
                                : next);
                        }
                        compositionText = null;
                    });
                    return false;
                },
            },
            handleClick(_view, position, event) {
                if (!event.metaKey && !event.ctrlKey) return false;
                const current = mapping();
                const offset = current.positionToOffset(position);
                const entry = options.decorations?.find(entry => offset >= entry.start && offset <= entry.end && typeof entry.treatment === 'object');
                if (!entry || typeof entry.treatment !== 'object') return false;
                options.onOpenLink?.(entry.treatment.url);
                return true;
            },
        },
        onUpdate: () => { if (!applyingExternal) options.onChange?.(read()); options.onCaretChange?.(); },
        onSelectionUpdate: () => { if (!applyingExternal) options.onSelection?.(read()); options.onCaretChange?.(); },
        onFocus: () => options.onFocus?.(),
        onBlur: () => options.onBlur?.(),
    });

    function bind(doc: ProseMirrorNode, text: string, references: readonly ComposerEditorReference[]) {
        const bound = boundComposerEditorReferences(text, references);
        let index = 0;
        doc.descendants(node => {
            if (node.type.name === 'composerReference') {
                const reference = bound[index++];
                if (reference) bindings.set(node, reference);
            }
        });
    }
    function replaceDocument(text: string, references: readonly ComposerEditorReference[], selection?: ComposerEditorSelection, history = false) {
        const next = editor.schema.nodeFromJSON(composerTextToDoc(text, references));
        bind(next, text, references);
        const current = editor.state.doc;
        let transaction: Transaction = editor.state.tr;
        const start = current.content.findDiffStart(next.content);
        if (start !== null) {
            const end = current.content.findDiffEnd(next.content)!;
            const overlap = Math.max(0, start - Math.min(end.a, end.b));
            transaction = transaction.replace(start, end.a + overlap, next.slice(start, end.b + overlap));
        }
        bind(transaction.doc, text, references);
        const mapped = mapping(transaction.doc);
        if (selection) transaction.setSelection(TextSelection.create(transaction.doc,
            mapped.offsetToPosition(selection.start), mapped.offsetToPosition(selection.end)));
        applyingExternal = true;
        try { editor.view.dispatch(transaction.setMeta('addToHistory', history)); }
        finally { applyingExternal = false; }
        for (const refresh of chipRefreshers) refresh();
    }
    function update(next: ComposerEditorControllerOptions) {
        if (composing || editor.view.composing) { deferred = next; return; }
        if (next.attachmentIds) {
            const ids = new Set(next.attachmentIds);
            for (const id of previousAttachmentIds) if (!ids.has(id)) removedAttachmentIds.add(id);
            for (const id of ids) removedAttachmentIds.delete(id);
            previousAttachmentIds = ids;
        }
        options = next;
        editor.setEditable(next.editable !== false, false);
        replaceDocument(next.text, next.references ?? []);
    }
    replaceDocument(initial.text, initial.references ?? [], { start: initial.text.length, end: initial.text.length });
    mounted = true;
    return {
        editor, read, update,
        setTextAndSelection(text: string, selection: ComposerEditorSelection) {
            if (composing || editor.view.composing) return;
            const previous = read();
            const references = reconcileStructuredInputMentionsWithTextChange({
                previousText: previous.text,
                nextText: text,
                previousSelection: previous.selection,
                mentions: previous.references.map(reference => ({ ...reference, tokenText: reference.token })),
            }).map(({ tokenText: _tokenText, ...reference }) => reference);
            replaceDocument(text, references, selection, true);
            options.onChange?.(read());
        },
        setSelection(selection: ComposerEditorSelection) {
            if (composing || editor.view.composing) return;
            const current = mapping();
            editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc,
                current.offsetToPosition(selection.start), current.offsetToPosition(selection.end))));
        },
        getCaretRect() {
            const coords = editor.view.coordsAtPos(editor.state.selection.head);
            return { left: coords.left, top: coords.top, height: coords.bottom - coords.top };
        },
        offsetAtPoint(point: Readonly<{ x: number; y: number }>): number | null {
            const position = editor.view.posAtCoords({ left: point.x, top: point.y });
            return position ? mapping().positionToOffset(position.pos) : null;
        },
        setDropCaret(offset: number | null) {
            if (offset === dropOffset) return;
            dropOffset = offset;
            editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
        },
        destroy: () => editor.destroy(),
    };
}
