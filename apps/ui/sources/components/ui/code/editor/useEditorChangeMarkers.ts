import * as React from 'react';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import type { TextEditorHandle, EditorDecoration } from './codeEditorTypes';
import { revertEditorChangeInDraft, type EditorChangeMarker } from './editorChangeMarkers';

export function useEditorChangeMarkers(params: Readonly<{
    editor: TextEditorHandle | null;
    /** Only the active tab in the focused details group registers palette/keyboard commands. */
    active: boolean;
    /** The loaded/saved file version and selected Changes scope, never the draft text. */
    seedKey: string;
    markers: readonly EditorChangeMarker[];
}>) {
    const { editor, active, seedKey, markers } = params;
    const [selected, setSelected] = React.useState<EditorChangeMarker | null>(null);
    const selectionRef = React.useRef<Readonly<{ marker: EditorChangeMarker; text: string }> | null>(null);
    const close = React.useCallback(() => {
        if (!selectionRef.current) return;
        selectionRef.current = null;
        setSelected(null);
    }, []);
    const markersRef = React.useRef(markers);
    markersRef.current = markers;
    const seeded = React.useMemo(() => markersRef.current, [seedKey]);
    React.useEffect(() => {
        editor?.setDecorations?.('change', seeded);
        selectionRef.current = null;
        setSelected(null);
        return () => { selectionRef.current = null; editor?.setDecorations?.('change', []); };
    }, [editor, seedKey, seeded]);
    React.useEffect(() => { if (!active) close(); }, [active, close]);
    React.useEffect(() => editor?.onDecorationPress?.((layer, item: EditorDecoration) => {
        if (!active || layer !== 'change' || !('kind' in item)) return;
        const source = seeded.find((marker) => marker.id === item.id);
        if (source && editor) {
            const marker = { ...source, startLine: item.startLine, endLine: item.endLine };
            selectionRef.current = { marker, text: editor.getValue() };
            setSelected(marker);
        }
    }), [active, editor, seeded]);
    const onDocumentChange = React.useCallback((text: string) => {
        if (selectionRef.current && selectionRef.current.text !== text) close();
    }, [close]);
    const next = React.useCallback(() => { editor?.runCommand?.('nextChange'); }, [editor]);
    const previous = React.useCallback(() => { editor?.runCommand?.('prevChange'); }, [editor]);
    useKeyboardShortcutHandlers(React.useMemo(() => active && editor?.runCommand && seeded.length > 0 ? {
        'files.editor.change.next': next, 'files.editor.change.previous': previous,
    } : {}, [active, editor, seeded.length, next, previous]));
    const revertInDraft = React.useCallback(async (marker: EditorChangeMarker) => {
        if (!editor?.runCommand) return { ok: false as const, reason: 'unavailable' as const };
        if (selectionRef.current?.marker !== marker) return { ok: false as const, reason: 'moved_on' as const };
        await editor.flushPendingChange();
        if (selectionRef.current?.marker !== marker || selectionRef.current.text !== editor.getValue()) {
            close();
            return { ok: false as const, reason: 'moved_on' as const };
        }
        const result = revertEditorChangeInDraft(editor.getValue(), marker);
        if (result.ok) {
            editor.runCommand({ replaceDocument: result.text });
            close();
        }
        return result;
    }, [close, editor]);
    return React.useMemo(() => ({ selected, close, revertInDraft, next, previous, onDocumentChange }), [selected, close, revertInDraft, next, previous, onDocumentChange]);
}

export type EditorChangeMarkersController = ReturnType<typeof useEditorChangeMarkers>;
