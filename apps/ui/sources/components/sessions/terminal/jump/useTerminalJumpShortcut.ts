import * as React from 'react';

import { useOptionalUniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { useDestinationFocus } from '@/components/appShell/workspace/DestinationInstanceHost';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import type { KeyboardShortcutHandlers } from '@/keyboard/runtime';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { presentTerminalActionFailure } from '@/components/sessions/terminal/terminalActionFailure';

import { useSessionTerminalAvailability } from '../useSessionTerminalAvailability';
import { useSessionTerminalAction } from '../useSessionTerminalAction';
import { useSessionTerminalWorkspace } from '../useSessionTerminalWorkspace';

const NO_HANDLERS: KeyboardShortcutHandlers = {};

/**
 * Terminal workspace commands of the focused session, including Jump (terminal lab B4). The view
 * passes its own registered pane scope, so the commands address exactly the terminals that session's
 * strip shows. Only the focused destination registers — in a split workspace the shortcut follows
 * focus, not the last mounted session — and only where the Home has the embedded terminal.
 */
export function useTerminalJumpShortcut(paneScopeId: string): void {
    const focused = useDestinationFocus();
    const serverId = parseSessionPaneScopeId(paneScopeId)?.address?.serverId ?? null;
    const { terminalEnabled } = useSessionTerminalAvailability(serverId);
    const runtime = useOptionalUniversalSearchRuntime();
    const sessionId = parseSessionPaneScopeId(paneScopeId)?.sessionId ?? '';
    const pane = useAppPaneScope(paneScopeId);
    const toggle = useSessionTerminalAction({ sessionId, scopeId: paneScopeId, serverId });
    const { execute } = useSessionTerminalWorkspace(paneScopeId);
    const enabled = focused && terminalEnabled && Boolean(sessionId);
    const handlers = React.useMemo<KeyboardShortcutHandlers>(() => {
        if (!enabled) return NO_HANDLERS;
        const run = (actionId: 'session.terminals.open' | 'session.terminals.split') => {
            void execute(actionId, { target: { kind: 'workspace_shell' } }).then((result) => {
                if (!result.ok) presentTerminalActionFailure(result);
                else if (result.result && typeof result.result === 'object' && 'ok' in result.result && result.result.ok === false) presentTerminalActionFailure({});
            }).catch(() => presentTerminalActionFailure({}));
        };
        return {
            ...(runtime ? { 'terminal.jump': () => runtime.open(undefined, undefined, { terminals: { scopeId: paneScopeId } }) } : {}),
            'terminal.toggle': toggle.onPress,
            'terminal.newShell': () => run('session.terminals.open'),
            ...(pane.scopeState?.bottom.isOpen && pane.scopeState.bottom.activeTabId === 'terminal'
                ? { 'terminal.split': () => run('session.terminals.split') } : {}),
        };
    }, [enabled, execute, pane.scopeState?.bottom.activeTabId, pane.scopeState?.bottom.isOpen, paneScopeId, runtime, toggle.onPress]);
    useKeyboardShortcutHandlers(handlers);
}
