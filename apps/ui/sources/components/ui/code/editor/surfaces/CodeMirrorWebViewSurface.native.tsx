import React from 'react';
import { PixelRatio, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useUnistyles } from 'react-native-unistyles';

import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import type { CodeEditorFindHandle, CodeEditorFindSnapshot, CodeEditorHandle, CodeEditorProps, CodeEditorHistory, EditorDecoration, EditorDecorationLayer } from '../codeEditorTypes';
import { encodeChunkedEnvelope, decodeChunkedEnvelope } from '@/components/ui/webview/bridge/chunkedBridge';
import { buildCodeMirrorWebViewHtml } from '../bridge/codemirrorWebViewHtml';
import { resolveCodeMirrorWebViewLanguageSpec } from '../bridge/resolveCodeMirrorWebViewLanguageSpec';
import { resolveCodeEditorTheme } from '../editorTheme';
import { readCodeMirrorFindStatus } from '../bridge/codeEditorFindBridge';
import type { CodeEditorFindMessage, CodeEditorFindSet } from '../bridge/codeEditorFindBridge';
import { useEmbeddedEditorKeyboard } from '@/keyboard/KeyboardShortcutProvider';
import { resolveCodeMonoFontFamily } from '../../codeTypography';

function createMessageId(): string {
    return Math.random().toString(36).slice(2);
}

function readEditorPosition(payload: unknown) {
    if (!payload || typeof payload !== 'object' || !('line' in payload) || !('character' in payload)) return null;
    const { line, character } = payload;
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1
        || typeof character !== 'number' || !Number.isInteger(character) || character < 0) return null;
    return { line, character };
}

export const CodeMirrorWebViewSurface = React.forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeMirrorWebViewSurface(
    props,
    ref,
) {
    const { theme } = useUnistyles();
    const keyboard = useEmbeddedEditorKeyboard();
    const keyboardRef = React.useRef(keyboard);
    keyboardRef.current = keyboard;
    const uiFontScale = useLocalSetting('uiFontScale');
    const canvas = props.presentation === 'canvas';
    const editorTheme = React.useMemo(
        // A canvas editor sits on the page's own surface, a framed one on the inset well.
        () => resolveCodeEditorTheme(theme, canvas ? { backgroundColor: theme.colors.surface.base } : {}),
        [
            canvas,
            theme.colors.surface.base,
            theme.dark,
            theme.colors.accent.blue,
            theme.colors.border.default,
            theme.colors.surface.inset,
            theme.colors.surface.elevated,
            theme.colors.syntax.comment,
            theme.colors.syntax.default,
            theme.colors.syntax.function,
            theme.colors.syntax.keyword,
            theme.colors.syntax.number,
            theme.colors.syntax.string,
            theme.colors.text.primary,
            theme.colors.text.tertiary,
            theme.colors.find.matchAll,
            theme.colors.find.matchCurrent,
            theme.colors.find.matchCurrentForeground,
        ],
    );
    const webViewRef = React.useRef<WebView>(null);
    const readyRef = React.useRef(false);
    const pendingInitRef = React.useRef<null | { doc: string }>(null);
    const lastDocRef = React.useRef(props.value);
    const pendingDocRequestRef = React.useRef(new Map<string, { resolve: () => void; timeoutId: any }>());
    const latestLanguageRef = React.useRef(props.language);
    const latestReadOnlyRef = React.useRef(false);
    const gutterPropsRef = React.useRef({ lineNumberDigits: props.lineNumberDigits ?? 1, reviewLaneWidth: props.reviewLaneWidth ?? 0 });
    gutterPropsRef.current = { lineNumberDigits: props.lineNumberDigits ?? 1, reviewLaneWidth: props.reviewLaneWidth ?? 0 };
    const focusedRef = React.useRef(false);
    const findOpenRef = React.useRef(false);
    const findRequestRef = React.useRef<CodeEditorFindSet | null>(null);
    const findSnapshotRef = React.useRef<CodeEditorFindSnapshot>({
        query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' },
    });
    const findListenersRef = React.useRef(new Set<() => void>());
    const cursorRef = React.useRef<ReturnType<NonNullable<CodeEditorHandle['getCursorPosition']>>>(null);
    const pointerListenersRef = React.useRef(new Set<Parameters<NonNullable<CodeEditorHandle['onPointerPosition']>>[0]>());
    const activationListenersRef = React.useRef(new Set<Parameters<NonNullable<CodeEditorHandle['onActivatePosition']>>[0]>());
    const historyRef = React.useRef<CodeEditorHistory>({ canUndo: false, canRedo: false });
    const historyListenersRef = React.useRef(new Set<(state: CodeEditorHistory) => void>());
    const pendingRevealRef = React.useRef<null | { line: number; focus?: boolean; select?: boolean; behavior?: 'smooth' | 'instant' }>(
        props.initialLine ? { line: props.initialLine, behavior: 'instant' } : null,
    );
    const onReadyRef = React.useRef(props.onReady);
    onReadyRef.current = props.onReady;
    React.useEffect(() => {
        pendingRevealRef.current = props.initialLine ? { line: props.initialLine, behavior: 'instant' } : null;
        historyRef.current = { canUndo: false, canRedo: false };
        for (const listener of historyListenersRef.current) listener(historyRef.current);
    }, [props.resetKey]);
    const decorationsRef = React.useRef(new Map<EditorDecorationLayer, readonly EditorDecoration[]>());
    const decorationListenersRef = React.useRef(new Set<Parameters<CodeEditorHandle['onDecorationPress']>[0]>());
    const selectionRef = React.useRef<ReturnType<NonNullable<CodeEditorHandle['getSelection']>>>(null);
    const selectionListenersRef = React.useRef(new Set<() => void>());
    const publishSelection = React.useCallback((selection: typeof selectionRef.current) => {
        selectionRef.current = selection;
        for (const listener of selectionListenersRef.current) listener();
    }, []);

    const wrapLines = props.wrapLines ?? true;
    const showLineNumbers = props.showLineNumbers ?? true;
    const readOnly = props.readOnly ?? false;
    const changeDebounceMs = typeof props.changeDebounceMs === 'number' ? props.changeDebounceMs : 250;
    const maxChunkBytes = typeof props.bridgeMaxChunkBytes === 'number' ? props.bridgeMaxChunkBytes : 64_000;

    latestLanguageRef.current = props.language;
    latestReadOnlyRef.current = readOnly;

    const html = React.useMemo(
        () =>
            buildCodeMirrorWebViewHtml({
                theme: editorTheme,
                wrapLines,
                showLineNumbers,
                changeDebounceMs,
                maxChunkBytes,
                uiFontScale,
                osFontScale: typeof PixelRatio.getFontScale === 'function' ? PixelRatio.getFontScale() : 1,
                fontFamily: resolveCodeMonoFontFamily(),
            }),
        [
            changeDebounceMs,
            editorTheme,
            maxChunkBytes,
            showLineNumbers,
            uiFontScale,
            wrapLines,
        ],
    );

    const postEnvelope = React.useCallback(
        (envelope: { v: 1; type: string; payload: unknown }) => {
            const messages = encodeChunkedEnvelope({ envelope, maxChunkBytes, messageId: createMessageId() });
            for (const msg of messages) {
                webViewRef.current?.postMessage(JSON.stringify(msg));
            }
        },
        [maxChunkBytes],
    );
    React.useEffect(() => {
        if (readyRef.current) postEnvelope({ v: 1, type: 'keyboard.config', payload: { signatures: keyboard.signatures } });
    }, [keyboard.signatures, postEnvelope]);

    const publishFind = React.useCallback((snapshot: CodeEditorFindSnapshot) => {
        findSnapshotRef.current = snapshot;
        for (const listener of findListenersRef.current) listener();
    }, []);
    const postFind = React.useCallback((message: CodeEditorFindMessage) => postEnvelope(message), [postEnvelope]);
    const seedFind = React.useCallback<CodeEditorFindHandle['seed']>((query, options, target) => {
        const request: CodeEditorFindSet = { query, options, ...(target ? { target } : {}) };
        findOpenRef.current = true;
        findRequestRef.current = request;
        publishFind({ query, options, status: query ? { kind: 'searching', total: 0 } : { kind: 'idle' } });
        if (readyRef.current) postFind({ v: 1, type: 'find.set', payload: request });
    }, [postFind, publishFind]);
    const find = React.useMemo<CodeEditorFindHandle>(() => ({
        presentation: 'shared',
        open: () => {
            if (!findOpenRef.current) {
                const { query, options } = findSnapshotRef.current;
                seedFind(query, options);
            }
        },
        seed: seedFind,
        set: (query, options) => seedFind(query, options),
        step: (direction) => { if (readyRef.current && findOpenRef.current) postFind({ v: 1, type: 'find.step', payload: { direction } }); },
        close: () => {
            findOpenRef.current = false;
            findRequestRef.current = null;
            publishFind({ ...findSnapshotRef.current, status: { kind: 'idle' } });
            if (readyRef.current) postFind({ v: 1, type: 'find.close', payload: {} });
        },
        getSnapshot: () => findSnapshotRef.current,
        subscribe: (listener) => { findListenersRef.current.add(listener); return () => { findListenersRef.current.delete(listener); }; },
        containsFocus: () => focusedRef.current,
        isOpen: () => findOpenRef.current,
        isInputFocused: () => false, // The host's shared FindBar owns its input focus.
    }), [postFind, publishFind, seedFind]);

    const flushPendingChange = React.useCallback(async (): Promise<void> => {
        if (!readyRef.current) return;
        const requestId = createMessageId();
        return await new Promise<void>((resolve) => {
            const timeoutId = setTimeout(() => {
                pendingDocRequestRef.current.delete(requestId);
                resolve();
            }, 1500);
            pendingDocRequestRef.current.set(requestId, { resolve, timeoutId });
            postEnvelope({
                v: 1,
                type: 'requestDoc',
                payload: { requestId },
            });
        });
    }, [postEnvelope]);

    React.useImperativeHandle(
        ref,
        () => ({
            getValue: () => lastDocRef.current,
            flushPendingChange,
            focus: () => {
                webViewRef.current?.requestFocus?.();
                if (readyRef.current) postEnvelope({ v: 1, type: 'focus', payload: {} });
            },
            find,
            getSelection: () => selectionRef.current,
            subscribeSelection: (listener) => {
                selectionListenersRef.current.add(listener);
                return () => { selectionListenersRef.current.delete(listener); };
            },
            revealLine: (line, options) => {
                const payload = { line, ...options };
                pendingRevealRef.current = payload;
                if (readyRef.current) { postEnvelope({ v: 1, type: 'reveal', payload }); pendingRevealRef.current = null; }
            },
            runCommand: (command) => {
                if (readyRef.current) postEnvelope({ v: 1, type: 'command', payload: { command } });
            },
            subscribeHistory: (listener) => {
                historyListenersRef.current.add(listener);
                listener(historyRef.current);
                return () => { historyListenersRef.current.delete(listener); };
            },
            setDecorations: (layer, items) => {
                decorationsRef.current.set(layer, items);
                if (readyRef.current) postEnvelope({ v: 1, type: 'decorations.set', payload: { layer, items } });
            },
            onDecorationPress: (listener) => {
                decorationListenersRef.current.add(listener);
                return () => { decorationListenersRef.current.delete(listener); };
            },
            onPointerPosition: (listener) => {
                pointerListenersRef.current.add(listener);
                return () => { pointerListenersRef.current.delete(listener); };
            },
            onActivatePosition: (listener) => {
                activationListenersRef.current.add(listener);
                return () => { activationListenersRef.current.delete(listener); };
            },
            getCursorPosition: () => cursorRef.current,
        }),
        [find, flushPendingChange, postEnvelope],
    );

    const sendInit = React.useCallback(() => {
        if (!readyRef.current) return;
        const doc = pendingInitRef.current?.doc ?? lastDocRef.current;
        pendingInitRef.current = null;
        lastDocRef.current = doc;
        postEnvelope({
            v: 1,
            type: 'init',
            payload: {
                doc,
                language: resolveCodeMirrorWebViewLanguageSpec(latestLanguageRef.current),
                readOnly: latestReadOnlyRef.current,
                ...gutterPropsRef.current,
                ...(pendingRevealRef.current ? { reveal: pendingRevealRef.current } : {}),
            },
        });
        pendingRevealRef.current = null;
        postEnvelope({ v: 1, type: 'keyboard.config', payload: { signatures: keyboardRef.current.signatures } });
        if (findRequestRef.current) postFind({ v: 1, type: 'find.set', payload: findRequestRef.current });
        for (const [layer, items] of decorationsRef.current) postEnvelope({ v: 1, type: 'decorations.set', payload: { layer, items } });
    }, [postEnvelope, postFind]);

    React.useEffect(() => {
        if (lastDocRef.current === props.value) return;
        pendingInitRef.current = { doc: props.value };
        lastDocRef.current = props.value;
        if (readyRef.current) {
            postEnvelope({
                v: 1,
                type: 'setDoc',
                payload: { doc: props.value },
            });
        }
    }, [props.value]);

    React.useEffect(() => {
        if (!readyRef.current) return;
        sendInit();
    }, [props.language, readOnly, sendInit, props.lineNumberDigits, props.reviewLaneWidth]);

    React.useEffect(() => {
        return () => {
            readyRef.current = false;
            focusedRef.current = false;
            cursorRef.current = null;
            for (const listener of pointerListenersRef.current) listener(null);
            publishSelection(null);
            for (const pending of pendingDocRequestRef.current.values()) {
                clearTimeout(pending.timeoutId);
                pending.resolve();
            }
            pendingDocRequestRef.current.clear();
        };
    }, [props.resetKey, html]);

    return (
        <View
            testID={props.testID}
            style={{ flex: 1, borderWidth: canvas ? 0 : 1, borderColor: editorTheme.dividerColor, borderRadius: canvas ? 0 : 10, overflow: 'hidden', backgroundColor: editorTheme.backgroundColor }}
        >
            <WebView
                key={props.resetKey}
                ref={webViewRef}
                source={{ html }}
                style={{ flex: 1 }}
                onMessage={(event) => {
                    const raw = event.nativeEvent.data;
                    let parsed: any = null;
                    try {
                        parsed = JSON.parse(raw);
                    } catch {
                        return;
                    }
                    const decoded = decodeChunkedEnvelope({ message: parsed });
                    if (!decoded) return;

                    if (decoded.type === 'cursor') {
                        const position = readEditorPosition(decoded.payload);
                        if (position || decoded.payload === null) cursorRef.current = position;
                        return;
                    }
                    if (decoded.type === 'activate') {
                        const position = readEditorPosition(decoded.payload);
                        if (position) for (const listener of activationListenersRef.current) listener(position);
                        return;
                    }
                    if (decoded.type === 'pointer') {
                        if (decoded.payload === null) {
                            for (const listener of pointerListenersRef.current) listener(null);
                            return;
                        }
                        const position = readEditorPosition(decoded.payload);
                        const payload = decoded.payload;
                        if (!position || !payload || typeof payload !== 'object' || !('rect' in payload)) return;
                        const rect = payload.rect;
                        if (!rect || typeof rect !== 'object' || !('x' in rect) || !('y' in rect) || !('width' in rect) || !('height' in rect)) return;
                        const { x, y, width, height } = rect;
                        if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number'
                            || ![x, y, width, height].every(Number.isFinite)) return;
                        for (const listener of pointerListenersRef.current) listener({ ...position, rect: { x, y, width, height } });
                        return;
                    }

                    if (decoded.type === 'ready') {
                        readyRef.current = true;
                        sendInit();
                        return;
                    }
                    if (decoded.type === 'editor.ready') { onReadyRef.current?.(); return; }
                    if (decoded.type === 'find.open') { find.open(); return; }
                    if (decoded.type === 'keyboard.shortcut') {
                        const payload = decoded.payload;
                        if (!payload || typeof payload !== 'object' || !('key' in payload) || typeof payload.key !== 'string' || !('modifiers' in payload)) return;
                        const modifiers = payload.modifiers;
                        if (!modifiers || typeof modifiers !== 'object' || !('shift' in modifiers) || !('ctrl' in modifiers) || !('meta' in modifiers) || !('alt' in modifiers)) return;
                        keyboardRef.current.dispatch({ key: payload.key,
                            ...('code' in payload && typeof payload.code === 'string' ? { code: payload.code } : {}),
                            modifiers: { shift: modifiers.shift === true, ctrl: modifiers.ctrl === true, meta: modifiers.meta === true, alt: modifiers.alt === true },
                            repeat: 'repeat' in payload && payload.repeat === true,
                            isEditableTarget: true,
                        });
                        return;
                    }
                    if (decoded.type === 'history.state') {
                        const payload = decoded.payload;
                        if (payload && typeof payload === 'object' && 'canUndo' in payload && 'canRedo' in payload
                            && typeof payload.canUndo === 'boolean' && typeof payload.canRedo === 'boolean') {
                            historyRef.current = { canUndo: payload.canUndo, canRedo: payload.canRedo };
                            for (const listener of historyListenersRef.current) listener(historyRef.current);
                        }
                        return;
                    }

                    if (decoded.type === 'editor.focus') {
                        const payload = decoded.payload;
                        if (payload && typeof payload === 'object' && 'focused' in payload) focusedRef.current = payload.focused === true;
                        return;
                    }
                    if (decoded.type === 'decorations.press') {
                        const payload = decoded.payload as { layer?: unknown; item?: unknown } | null;
                        if (!payload || (payload.layer !== 'change' && payload.layer !== 'diagnostic' && payload.layer !== 'blame')) return;
                        if (!payload.item || typeof payload.item !== 'object' || !('id' in payload.item) || !('startLine' in payload.item)) return;
                        // The embedded editor returns the same host-authored item with engine-mapped positions.
                        const item = payload.item as EditorDecoration;
                        if (!decorationsRef.current.get(payload.layer)?.some((owned) => owned.id === item.id)) return;
                        for (const listener of decorationListenersRef.current) listener(payload.layer, item);
                        return;
                    }
                    if (decoded.type === 'selection') {
                        const payload = decoded.payload;
                        if (payload === null) { publishSelection(null); return; }
                        if (!payload || typeof payload !== 'object') return;
                        const value = payload as Record<string, unknown>;
                        if (!Number.isInteger(value.startLine) || Number(value.startLine) < 1
                            || !Number.isInteger(value.endLine) || Number(value.endLine) < Number(value.startLine)
                            || typeof value.text !== 'string') return;
                        const rect = value.rect;
                        const position = rect && typeof rect === 'object' ? rect as Record<string, unknown> : null;
                        publishSelection({ startLine: Number(value.startLine), endLine: Number(value.endLine), text: value.text,
                            rect: position && ['x', 'y', 'width', 'height'].every((key) => typeof position[key] === 'number' && Number.isFinite(position[key]))
                                ? { x: Number(position.x), y: Number(position.y), width: Number(position.width), height: Number(position.height) } : null,
                            collapsed: value.collapsed === true,
                        });
                        return;
                    }
                    if (decoded.type === 'find.status') {
                        const status = readCodeMirrorFindStatus(decoded.payload, findSnapshotRef.current);
                        if (status && findOpenRef.current) publishFind({ ...findSnapshotRef.current, status });
                        return;
                    }
                    if (decoded.type === 'error') {
                        readyRef.current = false;
                        cursorRef.current = null;
                        for (const listener of pointerListenersRef.current) listener(null);
                        publishSelection(null);
                        if (findOpenRef.current) publishFind({ ...findSnapshotRef.current, status: { kind: 'unavailable', reason: 'unsupportedEngine' } });
                        return;
                    }

                    if (decoded.type === 'docChanged') {
                        const payload: any = decoded.payload;
                        if (payload && typeof payload.doc === 'string') {
                            lastDocRef.current = payload.doc;
                            props.onChange(payload.doc);
                        }
                        return;
                    }

                    if (decoded.type === 'docSnapshot') {
                        const payload: any = decoded.payload;
                        const requestId = payload && typeof payload.requestId === 'string' ? payload.requestId : '';
                        const doc = payload && typeof payload.doc === 'string' ? payload.doc : null;
                        if (!requestId || doc === null) return;

                        lastDocRef.current = doc;
                        props.onChange(doc);

                        const pending = pendingDocRequestRef.current.get(requestId);
                        if (pending) {
                            pendingDocRequestRef.current.delete(requestId);
                            clearTimeout(pending.timeoutId);
                            pending.resolve();
                        }
                        return;
                    }
                }}
            />
        </View>
    );
});
