import { afterEach, describe, expect, it } from 'vitest';
import { renderHook, createSessionFixture, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { useSessionTerminalDescribeContext } from './useSessionTerminalPresentation';

import type { SessionTerminalTabV1 } from '@happier-dev/protocol';

import type { TerminalSurfaceSummary } from '../terminalSurfaceSummary';
import { describeSessionTerminal, describeSessionTerminalTab, type SessionTerminalDescribeContext } from './describeSessionTerminal';

afterEach(standardCleanup);

const context = (overrides: Partial<SessionTerminalDescribeContext> = {}): SessionTerminalDescribeContext => ({
    agentId: 'claude',
    agentName: 'Claude',
    agentAsking: false,
    agentTerminalHost: 'tmux',
    sessionMachineId: 'mbp',
    sessionMachineName: 'MacBook Pro',
    machineName: (id) => (id === 'devbox' ? 'devbox' : null),
    ...overrides,
});
const summary = (overrides: Partial<TerminalSurfaceSummary>): TerminalSurfaceSummary => ({ title: null, bell: null, status: 'connected', error: null, url: null, ...overrides });

describe('describeSessionTerminal (terminal lab B1/A1/ST)', () => {
    it.each(['codex', 'acme.agent', null])('uses public Session Agent %s for the attached terminal mark', async agentId => {
        const initial = getStorage().getState();
        const session = createSessionFixture({ id: 'terminal-agent', serverId: 'home', metadataLayoutVersion: 1,
            metadata: { v: 1, ...(agentId ? { agentPresentation: { agentId } } : {}) } as never,
            ownerMetadataView: { path: '/private', host: 'home', flavor: 'claude' } });
        getStorage().setState({ sessions: { [session.id]: session } });
        try {
            const hook = await renderHook(() => useSessionTerminalDescribeContext(session.id, 'home'));
            const description = describeSessionTerminal({ id: 'agent-terminal', target: { kind: 'session_attach' } }, null, hook.getCurrent());
            expect(description.mark).toEqual(agentId ? { kind: 'agent', agentId } : { kind: 'shell' });
            await hook.unmount();
        } finally { getStorage().setState(initial, true); }
    });

    it('turns the agent’s tab amber while it asks in its own terminal, and names where it runs', () => {
        const asking = describeSessionTerminal({ id: 'a', target: { kind: 'session_attach' } }, summary({}), context({ agentAsking: true }));
        expect(asking).toMatchObject({ title: 'Claude', status: 'attention', mark: { kind: 'agent', agentId: 'claude' } });
        expect(asking.place).toContain('tmux');
        expect(describeSessionTerminal({ id: 'a', target: { kind: 'session_attach' } }, summary({}), context()).status).toBeNull();
    });

    it('keeps a shell on an unreachable machine out of the failed state; a start failure fails', () => {
        const shell = { id: 's', target: { kind: 'workspace_shell' as const } };
        expect(describeSessionTerminal(shell, summary({ status: 'error', error: 'terminal_machine_unreachable' }), context()).status).toBeNull();
        expect(describeSessionTerminal(shell, summary({ status: 'error', error: 'terminal_cwd_denied' }), context()).status).toBe('failed');
        expect(describeSessionTerminal(shell, summary({ status: 'exited' }), context()).status).toBe('exited');
    });

    it('marks a terminal serving an address as running and says the address, without a scheme', () => {
        const vite = describeSessionTerminal({ id: 'v', target: { kind: 'workspace_shell' }, title: 'vite' }, summary({ url: 'http://localhost:5173/' }), context());
        expect(vite).toMatchObject({ title: 'vite', status: 'running', detail: 'localhost:5173', url: 'http://localhost:5173/' });
    });

    it('names a shell on another machine by the machine and says where it runs', () => {
        const devbox = describeSessionTerminal({ id: 'd', target: { kind: 'machine_shell', machineId: 'devbox', cwd: '~/' } }, null, context());
        expect(devbox).toMatchObject({ title: 'devbox', mark: { kind: 'machine' } });
        expect(devbox.place).toContain('devbox');
    });

    it('reads a split tab as both names and asks with its loudest member', () => {
        const tab: SessionTerminalTabV1 = {
            id: 't', focusedTerminalId: 'z',
            terminals: [{ id: 'z', target: { kind: 'workspace_shell' }, title: 'zsh' }, { id: 'v', target: { kind: 'workspace_shell' }, title: 'vite' }],
            root: { kind: 'split', id: 'sp', ratio: 0.5, first: { kind: 'leaf', terminalId: 'z' }, second: { kind: 'leaf', terminalId: 'v' } },
        };
        const members = [
            describeSessionTerminal(tab.terminals[0]!, summary({}), context()),
            describeSessionTerminal(tab.terminals[1]!, summary({ url: 'http://localhost:5173/' }), context()),
        ];
        expect(describeSessionTerminalTab(tab, members)).toMatchObject({ title: 'zsh │ vite', status: 'running' });
    });
});
