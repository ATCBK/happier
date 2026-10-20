import type { Theme } from '@/theme';
import { parseThemeColor } from '@/theme/parseThemeColor';

export type CodeEditorSyntaxTheme = Readonly<{
    defaultColor: string;
    keywordColor: string;
    stringColor: string;
    commentColor: string;
    numberColor: string;
    functionColor: string;
}>;

export type CodeEditorTheme = Readonly<{
    monacoThemeName: 'happier-editor-light' | 'happier-editor-dark';
    isDark: boolean;
    backgroundColor: string;
    textColor: string;
    dividerColor: string;
    lineNumberColor: string;
    activeLineColor: string;
    selectionColor: string;
    findMatchColor?: string;
    findCurrentMatchColor?: string;
    findCurrentMatchForeground?: string;
    /** The change gutter (P4-R9): added/modified bars in the diff add colour, the deletion wedge in ink. */
    changeAddedColor: string;
    changeDeletedColor: string;
    syntax: CodeEditorSyntaxTheme;
}>;

type MonacoThemeData = Readonly<{
    base: 'vs' | 'vs-dark';
    inherit: true;
    rules: ReadonlyArray<Readonly<{ token: string; foreground: string }>>;
    colors: Readonly<Record<string, string>>;
}>;

type CodeEditorThemeSource = Readonly<{
    dark: boolean;
    colors: Pick<
        Theme['colors'],
        | 'accent'
        | 'border'
        | 'diff'
        | 'surface'
        | 'syntax'
        | 'text'
    > & Partial<Pick<Theme['colors'], 'find'>>;
}>;

/** Share of the focus blue in the current-line fill. */
const ACTIVE_LINE_TINT = 0.07;

function withoutHash(value: string): string {
    return value.startsWith('#') ? value.slice(1) : value;
}

export function resolveCodeEditorTheme(theme: CodeEditorThemeSource, paint: Partial<Pick<CodeEditorTheme, 'backgroundColor' | 'activeLineColor' | 'selectionColor'>> = {}): CodeEditorTheme {
    const colors = theme.colors;
    return {
        monacoThemeName: theme.dark ? 'happier-editor-dark' : 'happier-editor-light',
        isDark: Boolean(theme.dark),
        backgroundColor: paint.backgroundColor ?? colors.surface.inset,
        textColor: colors.text.primary,
        dividerColor: colors.border.default,
        lineNumberColor: colors.text.tertiary,
        // The caret's line: a breath of the focus blue across numbers and text (files lab ED1, `.ln.cur`).
        activeLineColor: paint.activeLineColor ?? parseThemeColor(colors.accent.blue)?.alpha(ACTIVE_LINE_TINT).rgb().string() ?? colors.surface.elevated,
        selectionColor: paint.selectionColor ?? colors.accent.blue,
        findMatchColor: colors.find?.matchAll,
        findCurrentMatchColor: colors.find?.matchCurrent,
        findCurrentMatchForeground: colors.find?.matchCurrentForeground,
        changeAddedColor: colors.diff.added.border,
        changeDeletedColor: colors.text.secondary,
        syntax: {
            defaultColor: colors.syntax.default,
            keywordColor: colors.syntax.keyword,
            stringColor: colors.syntax.string,
            commentColor: colors.syntax.comment,
            numberColor: colors.syntax.number,
            functionColor: colors.syntax.function,
        },
    };
}

/**
 * Monaco reads theme colors as hex only and paints anything else solid red (`Color.fromHex` falls back to
 * red), so the ink tokens (`rgba(...)` hairlines and meta ink) are converted here, at its one boundary.
 */
function toMonacoHex(value: string): string | null {
    if (/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(value)) return value.toLowerCase();
    const hexa = parseThemeColor(value)?.hexa().toLowerCase();
    return hexa === undefined ? null : hexa.endsWith('ff') ? hexa.slice(0, 7) : hexa;
}

export function buildMonacoEditorThemeData(editorTheme: CodeEditorTheme): MonacoThemeData {
    const syntax = editorTheme.syntax;
    return {
        base: editorTheme.isDark ? 'vs-dark' : 'vs',
        inherit: true,
        rules: [
            { token: '', foreground: withoutHash(syntax.defaultColor) },
            { token: 'comment', foreground: withoutHash(syntax.commentColor) },
            { token: 'string', foreground: withoutHash(syntax.stringColor) },
            { token: 'number', foreground: withoutHash(syntax.numberColor) },
            { token: 'keyword', foreground: withoutHash(syntax.keywordColor) },
            { token: 'operator', foreground: withoutHash(syntax.keywordColor) },
            { token: 'type', foreground: withoutHash(syntax.functionColor) },
            { token: 'function', foreground: withoutHash(syntax.functionColor) },
            { token: 'delimiter', foreground: withoutHash(syntax.defaultColor) },
        ],
        colors: Object.fromEntries(Object.entries({
            'editor.background': editorTheme.backgroundColor,
            'editor.foreground': syntax.defaultColor,
            'editorGutter.background': editorTheme.backgroundColor,
            'editorLineNumber.foreground': editorTheme.lineNumberColor,
            'editorLineNumber.activeForeground': editorTheme.textColor,
            'editorCursor.foreground': editorTheme.textColor,
            'editor.selectionBackground': editorTheme.selectionColor,
            'editor.inactiveSelectionBackground': editorTheme.activeLineColor,
            'editor.lineHighlightBackground': editorTheme.activeLineColor,
            'editor.lineHighlightBorder': '#00000000',
            'editorIndentGuide.background1': editorTheme.dividerColor,
            'editorIndentGuide.activeBackground1': editorTheme.lineNumberColor,
            'editorWidget.background': editorTheme.backgroundColor,
            'editorWidget.border': editorTheme.dividerColor,
            'input.background': editorTheme.backgroundColor,
            'input.foreground': editorTheme.textColor,
            'input.border': editorTheme.dividerColor,
        }).flatMap(([id, value]) => { const hex = toMonacoHex(value); return hex ? [[id, hex]] : []; })),
    };
}

/** Width of a change-gutter bar: an optical stroke, the same in both engines. */
const CHANGE_MARK_WIDTH_PX = 3;

/**
 * The change gutter's three marks, drawn the same in Monaco and CodeMirror (ade-shell ED3): added is a solid
 * bar, modified the same bar dashed (blue stays reserved for focus and links), deleted a small wedge pointing
 * at the gap where lines were removed. Returned as CSS declarations so each engine applies them to its own
 * marker element.
 */
export function resolveCodeEditorChangeMarkStyles(theme: Pick<CodeEditorTheme, 'changeAddedColor' | 'changeDeletedColor'>) {
    const bar = { width: `${CHANGE_MARK_WIDTH_PX}px`, top: '0', bottom: '0', left: '0', position: 'absolute' } as const;
    return {
        added: { ...bar, background: theme.changeAddedColor },
        modified: { ...bar, background: `repeating-linear-gradient(to bottom, ${theme.changeAddedColor} 0 3px, transparent 3px 6px)` },
        deleted: { position: 'absolute', left: '0', bottom: '-4px', width: '0', height: '0',
            borderTop: '4px solid transparent', borderBottom: '4px solid transparent', borderLeft: `5px solid ${theme.changeDeletedColor}` },
    } as const;
}

/**
 * The same marks as one stylesheet, for an engine whose marker element is already placed in its gutter lane
 * (Monaco's line decoration, CodeMirror's gutter marker): the bars set only their stroke, the wedge hangs
 * from the element's lower edge.
 */
export function formatCodeEditorChangeMarkCss(theme: Pick<CodeEditorTheme, 'changeAddedColor' | 'changeDeletedColor'>, selector: (kind: 'added' | 'modified' | 'deleted') => string,
    options: Readonly<{ /** CSS length from the start of the engine's marker lane. */ inset?: string }> = {}): string {
    const styles = resolveCodeEditorChangeMarkStyles(theme);
    const wedge = styles.deleted;
    const inset = options.inset ? `;margin-left:${options.inset}!important` : '';
    return [
        `${selector('added')}{width:${styles.added.width}!important;background:${styles.added.background}!important${inset}}`,
        `${selector('modified')}{width:${styles.modified.width}!important;background:${styles.modified.background}!important${inset}}`,
        `${selector('deleted')}{background:none!important;overflow:visible!important${inset}}`,
        `${selector('deleted')}::after{content:'';position:absolute;left:0;bottom:${wedge.bottom};width:0;height:0;border-top:${wedge.borderTop};border-bottom:${wedge.borderBottom};border-left:${wedge.borderLeft}}`,
    ].join('\n');
}
