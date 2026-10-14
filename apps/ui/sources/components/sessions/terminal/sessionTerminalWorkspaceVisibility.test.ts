import { describe, expect, it } from 'vitest';
import { appPaneReduce, createAppPaneState } from '@/components/appShell/panes/model/appPaneReducer';
import { SessionTerminalWorkspaceV1Schema } from '@happier-dev/protocol/terminal';
import { EMPTY_TERMINAL_WORKSPACE, selectVisibleSessionTerminalTabs } from './sessionTerminalWorkspace';

const scopeId = 'project:home:checkout';
function openOutput() {
    let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
    state = appPaneReduce(state, { type: 'setBottomTabState', scopeId, tabId: 'terminal', nextState: EMPTY_TERMINAL_WORKSPACE });
    return appPaneReduce(state, { type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: {
        id: 'output', target: { kind: 'terminal_view', machineId: 'machine', terminalId: 'pty', terminalKey: 'output-key', cwd: '/repo' },
    } } });
}

describe('visible AppPane terminal workspace', () => {
    it('retains hidden output without claiming it is visible, and restores it on reopen', () => {
        const opened = openOutput();
        expect(selectVisibleSessionTerminalTabs(opened, scopeId).map(tab => tab.id)).toEqual(['output']);
        const hidden = appPaneReduce(opened, { type: 'closeBottom', scopeId });
        expect(SessionTerminalWorkspaceV1Schema.parse(hidden.scopes[scopeId].bottom.tabState.terminal).tabs).toHaveLength(1);
        expect(selectVisibleSessionTerminalTabs(hidden, scopeId)).toEqual([]);
        expect(selectVisibleSessionTerminalTabs(appPaneReduce(hidden, { type: 'openBottom', scopeId, tabId: 'terminal' }), scopeId))
            .toEqual(selectVisibleSessionTerminalTabs(opened, scopeId));
    });

    it.each([
        { kind: 'builtin', id: 'tasks' },
        { kind: 'plugin', destination: { pluginId: 'example', localId: 'terminal' } },
    ] as const)('does not claim the terminal is visible under another $kind destination', destination => {
        const selected = appPaneReduce(openOutput(), { type: 'selectBottomDestination', scopeId, destination });
        expect(selected.scopes[scopeId].bottom.isOpen).toBe(true);
        expect(selectVisibleSessionTerminalTabs(selected, scopeId)).toEqual([]);
    });

    it('selects only the active tab but keeps every split member visible', () => {
        let state = appPaneReduce(openOutput(), { type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: {
            id: 'other', target: { kind: 'terminal_view', machineId: 'machine', terminalId: 'other-pty', terminalKey: 'other-key', cwd: '/repo' },
        } } });
        expect(selectVisibleSessionTerminalTabs(state, scopeId).map(tab => tab.id)).toEqual(['other']);
        state = appPaneReduce(state, { type: 'terminalWorkspace', scopeId, command: { type: 'focus', terminalId: 'output' } });
        state = appPaneReduce(state, { type: 'terminalWorkspace', scopeId, command: { type: 'split', terminal: {
            id: 'split', target: { kind: 'terminal_view', machineId: 'machine', terminalId: 'split-pty', terminalKey: 'split-key', cwd: '/repo' },
        }, availableWidthPx: 1000, minimumTerminalWidthPx: 320 } });
        expect(selectVisibleSessionTerminalTabs(state, scopeId).map(tab => tab.terminals.map(member => member.id)))
            .toEqual([['output', 'split']]);
    });

    it('hides retained tabs when their owning scope leaves, and preserves them when returning', () => {
        const opened = openOutput();
        const elsewhere = appPaneReduce(opened, { type: 'activateScope', scopeId: 'another-project' });
        expect(selectVisibleSessionTerminalTabs(elsewhere, scopeId)).toEqual([]);
        expect(selectVisibleSessionTerminalTabs(appPaneReduce(elsewhere, { type: 'activateScope', scopeId }), scopeId))
            .toEqual(selectVisibleSessionTerminalTabs(opened, scopeId));
        expect(selectVisibleSessionTerminalTabs(elsewhere, 'missing')).toEqual([]);
    });
});
