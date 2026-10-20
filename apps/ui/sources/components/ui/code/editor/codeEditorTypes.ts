import { normalizeCodeLanguageId } from '@/utils/code/normalizeCodeLanguageId';
import type { FindOptions, FindStatus } from '@happier-dev/plugin-ui/presentation';

export type CodeEditorFindTarget = Readonly<{ line: number; column?: number }>;
export type CodeEditorFindSnapshot = Readonly<{ query: string; options: FindOptions; status: FindStatus }>;
export type CodeEditorFindHandle = Readonly<{
    /** Monaco owns its widget; CodeMirror uses the host's shared bar. */
    presentation: 'native' | 'shared';
    /** Reveal/focus Find without replacing query state owned by the engine. */
    open: () => void;
    seed: (query: string, options: FindOptions, target?: CodeEditorFindTarget) => void;
    set: (query: string, options: FindOptions) => void;
    step: (direction: 1 | -1) => void;
    close: () => void;
    getSnapshot: () => CodeEditorFindSnapshot;
    subscribe: (listener: () => void) => () => void;
    containsFocus: () => boolean;
    isOpen: () => boolean;
    isInputFocused: () => boolean;
}>;

export type CodeEditorCommand = 'indent' | 'outdent' | 'undo' | 'redo' | 'moveLeft' | 'moveRight' | 'nextChange' | 'prevChange' | 'find'
    | Readonly<{ insert: string }> | Readonly<{ replaceDocument: string }>;
export type CodeEditorHistory = Readonly<{ canUndo: boolean; canRedo: boolean }>;
export type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type EditorDecorationLayer = 'change' | 'diagnostic' | 'blame';
/** Lines are 1-based; characters are 0-based UTF-16 offsets. */
export type EditorDecoration =
    | Readonly<{ layer?: 'change'; id: string; key: string; kind: 'added' | 'modified' | 'deleted'; startLine: number; endLine: number; removedLines?: readonly string[]; anchor?: 'before' | 'after' }>
    | Readonly<{ layer?: 'diagnostic'; id: string; severity: 'error' | 'warning' | 'information' | 'hint'; startLine: number; startCharacter: number; endLine: number; endCharacter: number; message: string; code?: string | number; source?: string }>
    | Readonly<{ layer?: 'blame'; id: string; startLine: number; lineCount: number; runId: string }>;

export type CodeEditorProps = Readonly<{
    resetKey: string;
    value: string;
    language: string | null;
    onChange: (value: string) => void;
    testID?: string;
    readOnly?: boolean;
    wrapLines?: boolean;
    showLineNumbers?: boolean;
    changeDebounceMs?: number;
    bridgeMaxChunkBytes?: number;
    onReady?: () => void;
    initialLine?: number;
    lineNumberDigits?: number;
    reviewLaneWidth?: number;
    /**
     * `framed` (default): a bordered inset box, as an editor inside a section. `canvas`: a whole document's
     * source that is the page itself (an Artifact's Markdown): no frame, on the page's own surface.
     */
    presentation?: 'framed' | 'canvas';
}>;

export type CodeEditorHandle = Readonly<{
    getValue: () => string;
    flushPendingChange: () => Promise<void>;
    /** Move editing focus into the incumbent platform surface. */
    focus?: () => void;
    find?: CodeEditorFindHandle;
    revealLine: (line: number, opts?: { focus?: boolean; select?: boolean; behavior?: 'smooth' | 'instant' }) => void;
    runCommand: (command: CodeEditorCommand) => void;
    subscribeHistory: (listener: (state: CodeEditorHistory) => void) => () => void;
    setDecorations: (layer: EditorDecorationLayer, items: readonly EditorDecoration[]) => void;
    onDecorationPress: (cb: (layer: EditorDecorationLayer, item: EditorDecoration) => void) => () => void;
    /** `collapsed` is a caret: Ask still asks about its line, but no selection toolbar is raised. */
    getSelection?: () => { startLine: number; endLine: number; text: string; rect: Rect | null; collapsed?: boolean } | null;
    subscribeSelection?: (listener: () => void) => () => void;
    getLineRect?: (line: number) => Rect | null;
    onPointerPosition?: (cb: (position: { line: number; character: number; rect: Rect } | null) => void) => () => void;
    onActivatePosition?: (cb: (position: { line: number; character: number }) => void) => () => void;
    getCursorPosition?: () => { line: number; character: number } | null;
}>;

/** Shared text-buffer capability for hosts that can also render a rich editor. */
export type TextEditorHandle = Pick<CodeEditorHandle, 'getValue' | 'flushPendingChange' | 'focus' | 'find'> & Partial<CodeEditorHandle>;

export function resolveMonacoLanguageId(language: string | null): string {
    const raw = normalizeCodeLanguageId(language);
    if (!raw) return 'plaintext';

    // Normalize common aliases/variants.
    if (raw === 'text' || raw === 'plaintext') return 'plaintext';
    if (raw === 'typescript' || raw === 'tsx') return 'typescript';
    if (raw === 'javascript' || raw === 'jsx') return 'javascript';
    if (raw === 'mdx') return 'markdown';
    if (raw === 'jsonc' || raw === 'json5') return 'json';
    if (raw === 'bash' || raw === 'zsh' || raw === 'dotenv' || raw === 'ssh-config') return 'shell';

    // Best-effort: pass through known language ids (Monaco basic languages are registered at runtime on web).
    return raw;
}
