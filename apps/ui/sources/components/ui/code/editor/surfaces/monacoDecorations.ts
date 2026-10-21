import type { editor, IPosition, IRange } from 'monaco-editor';
import type { EditorDecoration, EditorDecorationLayer } from '../codeEditorTypes';

type Collection = Pick<editor.IEditorDecorationsCollection, 'set' | 'getRange' | 'clear'>;
type DecorationEditor = Readonly<{
    getModel: () => Pick<editor.ITextModel, 'validateRange' | 'getLineMaxColumn' | 'getLineCount'> | null;
    createDecorationsCollection: () => Collection;
    onMouseDown: (listener: (event: editor.IEditorMouseEvent) => void) => { dispose(): void };
    onKeyDown?: (listener: (event: import('monaco-editor').IKeyboardEvent) => void) => { dispose(): void };
    getPosition: () => IPosition | null;
    setPosition: (position: IPosition) => void;
    revealLineInCenter: (line: number) => void;
    focus: () => void;
}>;

export function createMonacoDecorations(editor: DecorationEditor, monaco: Pick<typeof import('monaco-editor'), 'editor' | 'KeyCode'>,
    press: (layer: EditorDecorationLayer, item: EditorDecoration) => void) {
    const layers = new Map<EditorDecorationLayer, { collection: Collection; items: readonly EditorDecoration[] }>();
    function tracked(layer: EditorDecorationLayer) {
        const owned = layers.get(layer);
        if (!owned) return [];
        return owned.items.flatMap<EditorDecoration>((item, index) => {
            const range = owned.collection.getRange(index);
            if (!range) return [];
            if ('lineCount' in item) return [{ ...item, startLine: range.startLineNumber, lineCount: range.endLineNumber - range.startLineNumber + 1 }];
            if ('severity' in item) return [{ ...item, startLine: range.startLineNumber, startCharacter: range.startColumn - 1, endLine: range.endLineNumber, endCharacter: range.endColumn - 1 }];
            return [{ ...item, startLine: range.startLineNumber, endLine: range.endLineNumber }];
        });
    }
    const mouse = editor.onMouseDown((event) => {
        const line = event.target.position?.lineNumber;
        if (!line) return;
        const element = event.target.element;
        for (const layer of ['change', 'diagnostic', 'blame'] as const) {
            if (!element?.closest('.happier-editor-layer-' + layer)) continue;
            const item = tracked(layer).find((candidate) => candidate.startLine <= line && ('lineCount' in candidate ? candidate.startLine + candidate.lineCount - 1 : candidate.endLine) >= line);
            if (item) press(layer, item);
            return;
        }
    });
    function decoration(layer: EditorDecorationLayer, item: EditorDecoration, range: IRange) {
        const marker = 'happier-editor-layer-' + layer + ' happier-editor-' + layer + '-' + ('kind' in item ? item.kind : 'severity' in item ? item.severity : item.tone ?? 'run');
        return { range, options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            linesDecorationsClassName: marker, ...('severity' in item ? { inlineClassName: 'happier-editor-diagnostic-' + item.severity, hoverMessage: { value: item.message } } : {}) } };
    }
    function set(layer: EditorDecorationLayer, items: readonly EditorDecoration[]) {
        const model = editor.getModel();
        if (!model) return;
        const owned = layers.get(layer) ?? { collection: editor.createDecorationsCollection(), items: [] };
        layers.set(layer, owned);
        owned.items = items;
        owned.collection.set(items.map((item) => {
            const endLine = 'lineCount' in item ? item.startLine + Math.max(0, item.lineCount - 1) : item.endLine;
            const firstLine = Math.max(1, Math.min(model.getLineCount(), item.startLine));
            const deleted = 'kind' in item && item.kind === 'deleted';
            const anchorColumn = deleted ? (item.anchor === 'before' ? 1 : model.getLineMaxColumn(firstLine)) : 1;
            const range: IRange = model.validateRange({ startLineNumber: item.startLine, startColumn: 'startCharacter' in item ? item.startCharacter + 1 : anchorColumn,
                endLineNumber: endLine, endColumn: deleted ? anchorColumn : 'endCharacter' in item ? item.endCharacter + 1 : model.getLineMaxColumn(Math.max(1, Math.min(model.getLineCount(), endLine))) });
            return decoration(layer, item, range);
        }));
    }
    function remove(layer: EditorDecorationLayer, id: string) {
        const owned = layers.get(layer);
        if (!owned?.items.some(item => item.id === id)) return;
        const remaining = owned.items.flatMap((item, index) => {
            const range = owned.collection.getRange(index);
            return item.id !== id && range ? [{ item, range }] : [];
        });
        owned.items = remaining.map(({ item }) => item);
        owned.collection.set(remaining.map(({ item, range }) => decoration(layer, item, range)));
    }
    function navigate(direction: 1 | -1) {
        const changes = tracked('change').sort((a, b) => a.startLine - b.startLine);
        if (!changes.length) return;
        const line = editor.getPosition()?.lineNumber ?? 1;
        const item = direction === 1 ? changes.find((entry) => entry.startLine > line) ?? changes[0]!
            : [...changes].reverse().find((entry) => entry.startLine < line) ?? changes[changes.length - 1]!;
        editor.setPosition({ lineNumber: item.startLine, column: 1 });
        editor.revealLineInCenter(item.startLine);
        editor.focus();
        press('change', item);
    }
    const keyboard = editor.onKeyDown?.((event) => {
        if (event.browserEvent.isComposing || !event.altKey || event.ctrlKey || event.metaKey || event.keyCode !== monaco.KeyCode.F5) return;
        if (!tracked('change').length) return;
        event.preventDefault(); event.stopPropagation();
        navigate(event.shiftKey ? -1 : 1);
    });
    return { set, remove, navigate, dispose: () => { keyboard?.dispose(); mouse.dispose(); for (const layer of layers.values()) layer.collection.clear(); layers.clear(); } };
}
