import * as React from 'react';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import type { TextEditorHandle, EditorDecoration, CodeEditorDocumentChange } from './codeEditorTypes';
import { rederiveEditorChangeMarkers, revertEditorChangeInDraft, type EditorChangeMarker } from './editorChangeMarkers';

export function useEditorChangeMarkers(params: Readonly<{
    editor: TextEditorHandle | null;
    /** Only the active tab in the focused details group registers palette/keyboard commands. */
    active: boolean;
    /** The loaded/saved file version and selected Changes scope, never the draft text. */
    seedKey: string;
    markers: readonly EditorChangeMarker[];
    seedText?: string;
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
    const seedTextRef = React.useRef(params.seedText);
    seedTextRef.current = params.seedText;
    const seededText = React.useMemo(() => seedTextRef.current, [seedKey]);
    React.useEffect(() => {
        const projected = editor && seededText !== undefined ? rederiveEditorChangeMarkers(seededText, editor.getValue(), seeded) : seeded;
        if (projected) editor?.setDecorations?.('change', projected);
        selectionRef.current = null;
        setSelected(null);
        return () => { selectionRef.current = null; editor?.setDecorations?.('change', []); };
    }, [editor, seedKey, seeded, seededText]);
    React.useEffect(() => { if (!active) close(); }, [active, close]);
    React.useEffect(() => {
        let retired = false;
        const unsubscribe = editor?.onDecorationPress?.(async (layer, item: EditorDecoration) => {
            if (!active || layer !== 'change' || !('kind' in item)) return;
            const source = seeded.find((marker) => marker.id === item.id);
            if (source && editor) {
                close();
                // Publish the engine's pending debounce before the host chooses draft or disk Discard.
                await editor.flushPendingChange();
                if (retired) return;
                const marker = { ...source, ...item, hunk: source.hunk };
                selectionRef.current = { marker, text: editor.getValue() };
                setSelected(marker);
            }
        });
        return () => { retired = true; unsubscribe?.(); };
    }, [active, close, editor, seeded]);
    const onDocumentChange = React.useCallback((text: string, change?: CodeEditorDocumentChange) => {
        if (selectionRef.current && selectionRef.current.text !== text) close();
        if (change?.history && seededText !== undefined) {
            const projected = rederiveEditorChangeMarkers(seededText, text, seeded);
            if (projected) editor?.setDecorations?.('change', projected);
        }
    }, [close, editor, seeded, seededText]);
    const next = React.useCallback(() => { editor?.runCommand?.('nextChange'); }, [editor]);
    const previous = React.useCallback(() => { editor?.runCommand?.('prevChange'); }, [editor]);
    useKeyboardShortcutHandlers(React.useMemo(() => active && editor?.runCommand && seeded.length > 0 ? {
        'files.editor.change.next': next, 'files.editor.change.previous': previous,
    } : {}, [active, editor, seeded.length, next, previous]));
    const revertInDraft = React.useCallback(async (marker: EditorChangeMarker) => {
        if (!editor?.runCommand || !editor.removeDecoration) return { ok: false as const, reason: 'unavailable' as const };
        if (selectionRef.current?.marker !== marker) return { ok: false as const, reason: 'moved_on' as const };
        await editor.flushPendingChange();
        if (selectionRef.current?.marker !== marker || selectionRef.current.text !== editor.getValue()) {
            close();
            return { ok: false as const, reason: 'moved_on' as const };
        }
        const projected = seededText === undefined ? marker
            : rederiveEditorChangeMarkers(seededText, editor.getValue(), seeded)?.find(item => item.id === marker.id);
        if (!projected) return { ok: false as const, reason: 'moved_on' as const };
        const result = revertEditorChangeInDraft(editor.getValue(), { ...marker, hunk: projected.hunk, rangeNewLines: projected.rangeNewLines });
        if (result.ok) {
            editor.runCommand({ replaceDocument: result.text });
            editor.removeDecoration('change', marker.id);
            close();
        }
        return result;
    }, [close, editor, seeded, seededText]);
    return React.useMemo(() => ({ selected, close, revertInDraft, next, previous, onDocumentChange }), [selected, close, revertInDraft, next, previous, onDocumentChange]);
}

export type EditorChangeMarkersController = ReturnType<typeof useEditorChangeMarkers>;
