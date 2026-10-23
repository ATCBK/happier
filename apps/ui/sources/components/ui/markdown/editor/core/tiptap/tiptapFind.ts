import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { matchFindText } from '@happier-dev/plugin-ui/presentation';
import type { CodeEditorFindHandle, CodeEditorFindSnapshot } from '@/components/ui/code/editor/codeEditorTypes';

/** One rich-text matcher/decorator, shared by the web editor and the native WebView runtime. */
export function createTiptapFind(editor: Editor) {
    const key = new PluginKey('richFind');
    const listeners = new Set<() => void>();
    let snapshot: CodeEditorFindSnapshot = { query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' } };
    let opened = false;
    let current = 0;
    let ranges: Array<{ from: number; to: number }> = [];
    let decorations = DecorationSet.empty;
    const publish = () => { for (const listener of listeners) listener(); };
    const decorate = (reveal: boolean) => {
        if (editor.isDestroyed) return;
        decorations = DecorationSet.create(editor.state.doc, ranges.filter(range => range.to > range.from).map((range, index) => Decoration.inline(range.from, range.to, {
            'data-rich-find': index === current ? 'current' : 'match',
            style: `background-color:var(--happier-rich-find-${index === current ? 'current' : 'all'})${index === current ? ';color:var(--happier-rich-find-current-foreground)' : ''}`,
        })));
        editor.view.dispatch(editor.state.tr.setMeta(key, true));
        if (reveal && ranges[current]) {
            const node = editor.view.domAtPos(ranges[current]!.from).node;
            (node.nodeType === 1 ? node as Element : node.parentElement)?.scrollIntoView?.({ block: 'nearest' });
        }
    };
    const refresh = () => {
        if (editor.isDestroyed) return;
        const positions: number[] = [];
        let text = '';
        editor.state.doc.descendants((node, position) => {
            if (node.isTextblock && text.length > 0) { text += '\n'; positions.push(position); }
            if (node.isText && node.text) {
                text += node.text;
                for (let i = 0; i < node.text.length; i++) positions.push(position + i);
            }
        });
        const result = matchFindText(text, snapshot.query, snapshot.options);
        ranges = 'ranges' in result ? result.ranges.map(([from, to]) => ({ from: positions[from] ?? editor.state.doc.content.size,
            to: to > from ? (positions[to - 1] ?? editor.state.doc.content.size - 1) + 1 : positions[from] ?? editor.state.doc.content.size })) : [];
        current = Math.min(current, Math.max(0, ranges.length - 1));
        snapshot = { ...snapshot, status: !snapshot.query ? { kind: 'idle' } : 'invalidPattern' in result ? { kind: 'invalidPattern' }
            : { kind: 'results', current: ranges.length ? current + 1 : null, total: ranges.length, coverage: 'complete' } };
        decorate(true);
        publish();
    };
    editor.registerPlugin(new Plugin({ key, props: { decorations: () => decorations } }));
    const update = () => { if (opened) refresh(); };
    editor.on('update', update);
    const find: CodeEditorFindHandle = {
        presentation: 'shared',
        open: () => { opened = true; refresh(); },
        seed: (query, options) => { opened = true; current = 0; snapshot = { ...snapshot, query, options }; refresh(); },
        set: (query, options) => { opened = true; current = 0; snapshot = { ...snapshot, query, options }; refresh(); },
        step: direction => {
            if (!opened || !ranges.length) return;
            current = (current + direction + ranges.length) % ranges.length;
            snapshot = { ...snapshot, status: { kind: 'results', current: current + 1, total: ranges.length, coverage: 'complete' } };
            decorate(true); publish();
        },
        close: () => { opened = false; ranges = []; snapshot = { ...snapshot, status: { kind: 'idle' } }; decorate(false); publish(); },
        getSnapshot: () => snapshot,
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        containsFocus: () => editor.isFocused,
        isOpen: () => opened,
        isInputFocused: () => false,
    };
    return { find, destroy: () => { editor.off('update', update); listeners.clear(); if (!editor.isDestroyed) editor.unregisterPlugin(key); } };
}
