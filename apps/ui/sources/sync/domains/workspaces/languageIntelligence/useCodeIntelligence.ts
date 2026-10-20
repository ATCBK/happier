import * as React from 'react';

import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { machineCodeIntelligenceFallback } from '@/sync/ops/machineLanguageIntelligence';
import { bindCodeIntelligenceEditor } from './bindCodeIntelligenceEditor';
import type { CodeIntelligenceController, CodeIntelligenceControllerInput, CodeIntelligenceSnapshot } from './createCodeIntelligenceController';
import { useCodeIntelligenceController } from './useCodeIntelligenceController';

export type UseCodeIntelligenceInput = Readonly<{
    scope: WorkspaceScopeBase | null;
    path: string;
    languageId: string | null;
    active: boolean;
    /** P4 owns the buffer; this hook never subscribes the File page to keystrokes. */
    liveValue: Readonly<{ get(): string }>;
    editorHandleRef?: React.RefObject<CodeEditorHandle | null>;
    accountLifetime?: ServerAccountScopeLifetime | null;
    openLocation: CodeIntelligenceControllerInput['openLocation'];
}>;

const INACTIVE_SNAPSHOT: CodeIntelligenceSnapshot = Object.freeze({ mode: 'fallback', status: 'idle', selection: null, kind: null, result: null });
const noSubscription = () => () => undefined;
const getInactiveSnapshot = () => INACTIVE_SNAPSHOT;

/** Presentation leaves subscribe here; the File page keeps one stable controller. */
export function useCodeIntelligenceSnapshot(controller: CodeIntelligenceController | null): CodeIntelligenceSnapshot {
    return React.useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getSnapshot ?? getInactiveSnapshot, getInactiveSnapshot);
}

export function useCodeIntelligence(input: UseCodeIntelligenceInput) {
    const latest = React.useRef(input);
    latest.current = input;
    const lifetime = input.active && input.scope
        ? input.accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : input.accountLifetime
        : null;
    const serverId = input.scope?.serverId;
    const machineId = input.scope?.machineId;
    const rootPath = input.scope?.rootPath;
    const controllerInput = React.useMemo<CodeIntelligenceControllerInput | null>(() => {
        if (!input.active || !serverId || !machineId || !rootPath || !lifetime) return null;
        return {
            scope: { serverId, machineId, rootPath }, path: input.path, languageId: input.languageId, accountLifetime: lifetime,
            getText: () => latest.current.liveValue.get(),
            flushPendingChange: async () => { await latest.current.editorHandleRef?.current?.flushPendingChange(); },
            query: (request, signal) => machineCodeIntelligenceFallback(machineId, request, { serverId, accountId: lifetime.scope.accountId, signal }),
            openLocation: location => latest.current.openLocation(location),
        };
    }, [input.active, input.path, input.languageId, serverId, machineId, rootPath, lifetime]);
    const controller = useCodeIntelligenceController(controllerInput);

    const editorBinding = React.useRef<(() => void) | null>(null);
    const bindEditor = React.useCallback(() => {
        editorBinding.current?.();
        const editor = latest.current.editorHandleRef?.current;
        editorBinding.current = controller && editor ? bindCodeIntelligenceEditor(controller, editor) : null;
    }, [controller]);
    React.useEffect(() => {
        bindEditor();
        return () => { editorBinding.current?.(); editorBinding.current = null; };
    }, [bindEditor]);
    const runAtCursor = React.useCallback((kind: 'definition' | 'references') => {
        if (!controller) return 'pass' as const;
        const cursor = latest.current.editorHandleRef?.current?.getCursorPosition?.();
        const position = cursor ? { line: cursor.line - 1, character: cursor.character } : controller.getSnapshot().selection?.position;
        if (!position) return 'pass' as const;
        void controller[kind](position);
        return 'handled' as const;
    }, [controller]);
    useKeyboardShortcutHandlers(React.useMemo(() => input.active && controller ? {
        'code.goToDefinition': () => runAtCursor('definition'),
        'code.findReferences': () => runAtCursor('references'),
    } : {}, [input.active, controller, runAtCursor]));

    return React.useMemo(() => ({ controller, bindEditor }), [controller, bindEditor]);
}
