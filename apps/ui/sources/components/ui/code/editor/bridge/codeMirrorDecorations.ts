import type * as State from '@codemirror/state';
import type * as View from '@codemirror/view';
import type { EditorDecoration, EditorDecorationLayer } from '../codeEditorTypes';

type DecorationApi = Pick<typeof State, 'StateField' | 'StateEffect' | 'RangeSet' | 'RangeValue' | 'MapMode'>
    & Pick<typeof View, 'gutter' | 'GutterMarker' | 'Decoration' | 'EditorView'>;
type LayerItems = Readonly<{ layer: EditorDecorationLayer; items: readonly EditorDecoration[] }>;

/** The bundle producer includes this same implementation in the native WebView. */
export function createCodeMirrorDecorations(api: DecorationApi, press?: (layer: EditorDecorationLayer, item: EditorDecoration) => void) {
    const layers = ['change', 'diagnostic', 'blame'] as const;
    const set = api.StateEffect.define<LayerItems>();
    const remove = api.StateEffect.define<Readonly<{ layer: EditorDecorationLayer; id: string }>>();
    class Tracked extends api.RangeValue {
        override startSide = 1;
        override endSide = 1;
        override mapMode = api.MapMode.Simple;
        constructor(readonly item: EditorDecoration) { super(); }
    }
    const field = api.StateField.define<Readonly<Record<EditorDecorationLayer, State.RangeSet<Tracked>>>>({
        create: () => ({ change: api.RangeSet.empty, diagnostic: api.RangeSet.empty, blame: api.RangeSet.empty }),
        update(value, transaction) {
            let next = value;
            if (transaction.docChanged) next = { change: value.change.map(transaction.changes), diagnostic: value.diagnostic.map(transaction.changes), blame: value.blame.map(transaction.changes) };
            for (const effect of transaction.effects) {
                if (effect.is(remove)) {
                    const { layer, id } = effect.value;
                    next = { ...next, [layer]: next[layer].update({ filter: (_from, _to, value) => value.item.id !== id }) };
                    continue;
                }
                if (!effect.is(set)) continue;
                const ranges = effect.value.items.map((item) => {
                    const doc = transaction.state.doc;
                    const first = doc.line(Math.max(1, Math.min(doc.lines, item.startLine)));
                    const endLine = 'lineCount' in item ? item.startLine + Math.max(0, item.lineCount - 1) : item.endLine;
                    const last = doc.line(Math.max(first.number, Math.min(doc.lines, endLine)));
                    const deleted = 'kind' in item && item.kind === 'deleted';
                    const from = deleted ? (item.anchor === 'before' ? first.from : first.to)
                        : first.from + ('startCharacter' in item ? Math.min(first.length, Math.max(0, item.startCharacter)) : 0);
                    const to = deleted ? from : last.from + ('endCharacter' in item ? Math.min(last.length, Math.max(0, item.endCharacter)) : last.length);
                    return new Tracked(item).range(from, Math.max(from, to));
                });
                next = { ...next, [effect.value.layer]: api.RangeSet.of(ranges, true) };
            }
            return next;
        },
    });
    function project(state: State.EditorState, from: number, to: number, item: EditorDecoration): EditorDecoration {
        const first = state.doc.lineAt(from);
        const last = state.doc.lineAt(to);
        if ('lineCount' in item) return { ...item, startLine: first.number, lineCount: last.number - first.number + 1 };
        if ('severity' in item) return { ...item, startLine: first.number, startCharacter: from - first.from, endLine: last.number, endCharacter: to - last.from };
        return { ...item, startLine: first.number, endLine: last.number };
    }
    function items(state: State.EditorState, layer: EditorDecorationLayer): EditorDecoration[] {
        const result: EditorDecoration[] = [];
        for (let cursor = state.field(field)[layer].iter(); cursor.value; cursor.next()) result.push(project(state, cursor.from, cursor.to, cursor.value.item));
        return result;
    }
    function atLine(state: State.EditorState, layer: EditorDecorationLayer, from: number, to: number) {
        let found: EditorDecoration | null = null;
        state.field(field)[layer].between(from, to, (start, end, value) => { found ??= project(state, start, end, value.item); });
        return found;
    }
    class Marker extends api.GutterMarker {
        constructor(readonly layer: EditorDecorationLayer, readonly item: EditorDecoration) { super(); }
        override eq(other: View.GutterMarker) {
            if (!(other instanceof Marker)) return false;
            const role = (item: EditorDecoration) => 'kind' in item ? item.kind : 'severity' in item ? item.severity : item.tone ?? 'run';
            return this.item.id === other.item.id && this.item.startLine === other.item.startLine && role(this.item) === role(other.item);
        }
        override toDOM() {
            const element = document.createElement('span');
            element.className = 'happier-editor-marker happier-editor-' + this.layer + '-' + ('kind' in this.item ? this.item.kind : 'severity' in this.item ? this.item.severity : this.item.tone ?? 'run');
            return element;
        }
    }
    const gutters = layers.map((layer) => api.gutter({
        class: 'happier-editor-gutter-' + layer,
        lineMarker(editor, line) {
            const item = atLine(editor.state, layer, line.from, line.to);
            return item ? new Marker(layer, item) : null;
        },
        lineMarkerChange: (update) => update.docChanged || update.startState.field(field) !== update.state.field(field),
        domEventHandlers: {
            mousedown(editor, line) {
                const item = atLine(editor.state, layer, line.from, line.to);
                if (!item) return false;
                press?.(layer, item);
                return true;
            },
        },
    }));
    const diagnostics = api.EditorView.decorations.compute([field], (state) => {
        const ranges: State.Range<View.Decoration>[] = [];
        for (let cursor = state.field(field).diagnostic.iter(); cursor.value; cursor.next()) {
            const item = cursor.value.item;
            if (cursor.from === cursor.to || !('severity' in item)) continue;
            ranges.push(api.Decoration.mark({ class: 'happier-editor-diagnostic-' + item.severity, attributes: { title: item.message } }).range(cursor.from, cursor.to));
        }
        return api.Decoration.set(ranges, true);
    });
    function navigate(editor: View.EditorView, direction: 1 | -1): boolean {
        if (editor.composing) return false;
        const changes = items(editor.state, 'change');
        if (!changes.length) return false;
        const line = editor.state.doc.lineAt(editor.state.selection.main.head).number;
        const item = direction === 1 ? changes.find((entry) => entry.startLine > line) ?? changes[0]!
            : [...changes].reverse().find((entry) => entry.startLine < line) ?? changes[changes.length - 1]!;
        editor.dispatch({ selection: { anchor: editor.state.doc.line(item.startLine).from }, scrollIntoView: true });
        editor.focus();
        press?.('change', item);
        return true;
    }
    return { set, remove, field, items, navigate, extensions: [field, ...gutters, diagnostics] };
}
