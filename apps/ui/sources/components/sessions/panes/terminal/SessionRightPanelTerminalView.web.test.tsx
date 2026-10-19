import { createDeferred, createMachineFixture, createRootLayoutFeaturesResponse, createSessionFixture, flushHookEffects, renderScreen, type RenderScreenResult } from '@/dev/testkit';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { DaemonTerminalEnsureRequestSchema, DaemonTerminalRestartRequestSchema, DaemonTerminalResizeRequestSchema, DaemonTerminalStreamReadRequestSchema } from '@happier-dev/protocol/daemon/terminal';
import { ExternalActionMachineBootstrapV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { installSessionDetailsPanelCommonModuleMocks } from '../sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '../sessionPaneRuntimeTestHarness';
import { createAccountTokenForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { createSessionPaneScopeId } from '../sessionPaneScopeId';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import type { SessionEmbeddedTerminalPaneProps } from '@/components/sessions/terminal/useSessionEmbeddedTerminalPaneModel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const terminalOps = vi.hoisted(() => ({ ensure: vi.fn(), restart: vi.fn(), streamRead: vi.fn(), resize: vi.fn() }));
const machineTerminalEnsureSpy = terminalOps.ensure;
const machineTerminalRestartSpy = terminalOps.restart;
const machineTerminalStreamReadSpy = terminalOps.streamRead;
const machineTerminalResizeSpy = terminalOps.resize;
const terminalHandleInstances: Array<{
    write: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
}> = [];

let shouldTriggerResizeAfterReady = false;
let terminalRendererVersion = 0;
let scopeId: string;

installSessionDetailsPanelCommonModuleMocks();
vi.mock('socket.io-client', async importOriginal => (
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal)
));
// Only the daemon network and browser renderer are substituted; terminal
// admission, request/response codecs, workspace identity and stream state stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => (
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(async request => {
        const options = { serverId: request.serverId, accountId: request.accountId };
        switch (request.method) {
            case RPC_METHODS.DAEMON_TERMINAL_LIST: return { ok: true, terminals: [] };
            case RPC_METHODS.DAEMON_TERMINAL_ENSURE:
                return terminalOps.ensure(request.machineId, DaemonTerminalEnsureRequestSchema.parse(request.payload), options);
            case RPC_METHODS.DAEMON_TERMINAL_RESTART:
                return terminalOps.restart(request.machineId, DaemonTerminalRestartRequestSchema.parse(request.payload), options);
            case RPC_METHODS.DAEMON_TERMINAL_STREAM_READ:
                return terminalOps.streamRead(request.machineId, DaemonTerminalStreamReadRequestSchema.parse(request.payload), options);
            case RPC_METHODS.DAEMON_TERMINAL_RESIZE:
                return terminalOps.resize(request.machineId, DaemonTerminalResizeRequestSchema.parse(request.payload), options);
            default: throw new Error(`Unexpected terminal RPC: ${request.method}`);
        }
    })
));
const runtime = installSessionPaneRuntimeTestHarness({
    credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
    scopeId: ({ sessionId, serverId }) => createSessionPaneScopeId(sessionId, serverId),
    features: () => createRootLayoutFeaturesResponse({ features: { terminal: {
        embeddedPty: { enabled: true }, transport: { byteStream: { enabled: false } },
    } } }),
    request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v2/account/settings' && (init?.method ?? 'GET') === 'GET') return Response.json({
            content: { t: 'plain', v: { featureToggles: { 'terminal.embeddedPty': true },
                actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: {
                    'machines.terminal.open': ['ui'], 'machines.terminal.restart': ['ui'],
                } },
            } }, version: 0,
        });
        if (path === '/v1/machines') return Response.json(['machine-1', 'm-project', 'm-stale'].map(id =>
            ExternalActionMachineBootstrapV1Schema.parse({ id, kind: 'persistent', active: id !== 'm-stale',
                revokedAt: null, replacedByMachineId: id === 'm-stale' ? 'm-project' : null,
                installationId: `${id}-installation`, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                runnerContentKeyBinding: null, access: { custodian: { accountId: 'account-a', displayName: 'Terminal owner' },
                    role: 'manage', resourceMode: 'plain', accessState: 'ready' },
            })));
        return null;
    },
});

async function renderAndFlush(element: React.ReactElement<SessionEmbeddedTerminalPaneProps>): Promise<RenderScreenResult> {
    const screen = await renderScreen(<></>, { wrapper: runtime.Wrapper });
    const { readSessionTerminalWorkspace } = await import('@/components/sessions/terminal/sessionTerminalWorkspace');
    const { dispatchSessionTerminalWorkspaceCommand } = await import('@/components/sessions/terminal/sessionTerminalWorkspaceRuntime');
    await act(async () => {
        runtime.pane.openBottom({ tabId: 'terminal' });
        if (!runtime.pane.scopeState?.bottom.tabState.terminal) {
            runtime.pane.setBottomTabState('terminal', readSessionTerminalWorkspace(undefined));
        }
        const id = element.props.terminal?.id ?? element.props.terminalInstanceId ?? 'embedded';
        if (id !== 'embedded') dispatchSessionTerminalWorkspaceCommand(scopeId, { type: 'open', terminal: {
            id, target: element.props.terminal?.target ?? { kind: 'workspace_shell' },
        } });
    });
    await screen.update(element);
    const { EmbeddedTerminalPane } = await import('@/components/terminal/embedded/EmbeddedTerminalPane.web');
    await waitForHomeGovernance(() => {
        expect(screen.findByType(EmbeddedTerminalPane).props.controller.status)
            .not.toMatch(/^(not-open|connecting)$/);
        expect(screen.findByType(EmbeddedTerminalPane).props.controller.error).toBeNull();
    });
    await flushHookEffects();
    return screen;
}

/**
 * The sidebar-docked session terminal leaf: the PTY controller contract these cases pin. The Terminal
 * page around it (chips, pager) is covered by `SessionTerminalPage.test.tsx`.
 */
async function loadSessionRightPanelTerminalViewWeb() {
    const mod = await import('@/components/sessions/terminal/SessionEmbeddedTerminalPane.web');
    const Pane = mod.SessionEmbeddedTerminalPane;
    return function SidebarTerminalLeaf(props: Readonly<{ sessionId: string; scopeId: string }>) {
        return <Pane {...props} currentDockLocation="sidebar" testIdPrefix="session-rightpanel-terminal" />;
    };
}

async function loadSessionEmbeddedTerminalPaneWeb() {
    const mod = await import('@/components/sessions/terminal/SessionEmbeddedTerminalPane.web');
    return mod.SessionEmbeddedTerminalPane;
}

vi.mock('@/components/terminal/xterm/XtermTerminalView.web', () => ({
    XtermTerminalView: React.forwardRef<EmbeddedTerminalRendererHandle, {
        onReady: (cols: number, rows: number) => void;
        onResize: (cols: number, rows: number) => void;
    }>((props, ref) => {
        const handle = React.useMemo(() => ({
            write: vi.fn(),
            clear: vi.fn(),
            focus: vi.fn(),
            hasSelection: () => false,
            getSelectionText: () => '',
        }), [terminalRendererVersion]);

        React.useImperativeHandle(ref, () => ({
            ...handle,
            hasSelection: () => false,
            getSelectionText: () => '',
        }), [handle]);

        React.useEffect(() => {
            terminalHandleInstances.push(handle);
        }, [handle]);

        React.useEffect(() => {
            props.onReady(80, 24);
            if (!shouldTriggerResizeAfterReady) {
                return;
            }
            void Promise.resolve().then(() => {
                props.onResize(81, 24);
            });
        }, [props.onReady]);

        return React.createElement('XtermTerminalView', props);
    }),
}));

// Cold module transforms are setup, not part of a renderer interaction's clock.
await import('@/components/sessions/terminal/SessionEmbeddedTerminalPane.web');

describe('SessionRightPanelTerminalView.web', () => {
    beforeEach(async () => {
        shouldTriggerResizeAfterReady = false;
        terminalRendererVersion = 0;
        terminalHandleInstances.length = 0;
        scopeId = createSessionPaneScopeId('s1', runtime.serverId);
        storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: runtime.serverId, active: true,
            metadata: { machineId: 'machine-1', path: '/tmp', host: 'mbp.local' },
        })]);
        storage.getState().applyMachines([createMachineFixture({ storageMode: 'plain', activeAt: Date.now(),
            metadata: { ...createMachineFixture().metadata!, host: 'mbp.local' },
        })], true, { sourceServerId: runtime.serverId });
        const cache = await import('@/components/sessions/terminal/terminalSurfaceStateCache');
        for (const key of [`${scopeId}:terminal`, `${scopeId}:terminal:term-7`, `${scopeId}:attach`]) {
            cache.replaceTerminalSurfaceState(key, cache.createEmptyTerminalSurfaceState());
        }
        machineTerminalEnsureSpy.mockReset();
        machineTerminalRestartSpy.mockReset();
        machineTerminalStreamReadSpy.mockReset();
        machineTerminalResizeSpy.mockReset();

        machineTerminalEnsureSpy.mockResolvedValue({ ok: true, terminalId: 't1', reused: false });
        machineTerminalRestartSpy.mockResolvedValue({ ok: true, terminalId: 't2', reused: false });
        machineTerminalResizeSpy.mockResolvedValue({ ok: true });
        machineTerminalStreamReadSpy.mockImplementation(async (_machineId: string, input: { terminalId: string }) => ({
            ok: true,
            terminalId: input.terminalId,
            events: [],
            nextCursor: 0,
            done: true,
        }));
    });

    it('restarts the PTY when the user presses restart', async () => {
        const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();
        const screen = await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId={scopeId} />);

        expect(machineTerminalEnsureSpy).toHaveBeenCalledTimes(1);

        const restartButton = screen.findByTestId('session-rightpanel-terminal-restart');
        expect(restartButton).toBeTruthy();

        await screen.pressByTestIdAsync('session-rightpanel-terminal-restart');

        await waitForHomeGovernance(() => expect(machineTerminalRestartSpy).toHaveBeenCalledTimes(1));
    });

    it('uses a canonical session-scoped terminalKey', async () => {
        const SessionEmbeddedTerminalPaneWeb = await loadSessionEmbeddedTerminalPaneWeb();

        await renderAndFlush(
            <SessionEmbeddedTerminalPaneWeb
                sessionId="s1"
                scopeId={scopeId}
                currentDockLocation="details"
                testIdPrefix="pane-a"
            />,
        );

        expect(machineTerminalEnsureSpy).toHaveBeenCalledTimes(1);
        const ensureInput = machineTerminalEnsureSpy.mock.calls[0]?.[1];
        expect(ensureInput?.terminalKey).toBe(`${scopeId}:terminal`);
    });

    it('uses an instance-aware session terminalKey when a terminal tab instance is provided', async () => {
        const SessionEmbeddedTerminalPaneWeb = await loadSessionEmbeddedTerminalPaneWeb();

        await renderAndFlush(
            <SessionEmbeddedTerminalPaneWeb
                sessionId="s1"
                scopeId={scopeId}
                currentDockLocation="details"
                terminalInstanceId="term-7"
                testIdPrefix="pane-a"
            />,
        );

        expect(machineTerminalEnsureSpy).toHaveBeenCalledTimes(1);
        const ensureInput = machineTerminalEnsureSpy.mock.calls[0]?.[1];
        expect(ensureInput?.terminalKey).toBe(`${scopeId}:terminal:term-7`);
    });

    it('uses the typed session-attach launch intent without workspace-shell inputs', async () => {
        const SessionEmbeddedTerminalPaneWeb = await loadSessionEmbeddedTerminalPaneWeb();

        await renderAndFlush(
            <SessionEmbeddedTerminalPaneWeb
                sessionId="s1"
                scopeId={scopeId}
                currentDockLocation="details"
                terminal={{ id: 'session-attach', target: { kind: 'session_attach' } }}
                testIdPrefix="pane-attached"
            />,
        );

        expect(machineTerminalEnsureSpy).toHaveBeenCalledTimes(1);
        expect(machineTerminalEnsureSpy.mock.calls[0]?.[1]).toEqual({
            cols: 80,
            rows: 24,
            launch: { kind: 'session_attach', sessionId: 's1' },
            terminalKey: `${scopeId}:attach`,
            sessionId: 's1',
        });
    });

    it('uses the resolved session machine target when the session machine id is stale', async () => {
        storage.getState().applySessions([createSessionFixture({ id: 's1', serverId: runtime.serverId,
            metadata: { machineId: 'm-stale', path: '/workspace/repo', host: 'mbp.local' },
        })]);
        storage.getState().applyMachines([
            createMachineFixture({ id: 'm-stale', storageMode: 'plain', active: false, activeAt: 1,
                replacedByMachineId: 'm-project', metadata: { ...createMachineFixture().metadata!, host: 'mbp.local' } }),
            createMachineFixture({ id: 'm-project', storageMode: 'plain', activeAt: Date.now(),
                metadata: { ...createMachineFixture().metadata!, host: 'mbp.local' } }),
        ], true, { sourceServerId: runtime.serverId });

        const SessionEmbeddedTerminalPaneWeb = await loadSessionEmbeddedTerminalPaneWeb();

        await renderAndFlush(
            <SessionEmbeddedTerminalPaneWeb
                sessionId="s1"
                scopeId={scopeId}
                currentDockLocation="details"
                testIdPrefix="pane-a"
            />,
        );

        expect(machineTerminalEnsureSpy).toHaveBeenCalledTimes(1);
        expect(machineTerminalEnsureSpy.mock.calls[0]?.[0]).toBe('m-project');
        expect(machineTerminalEnsureSpy.mock.calls[0]?.[1]?.cwd).toBe('/workspace/repo');
    });

    it('does not re-ensure the PTY session when the terminal resizes', async () => {
        shouldTriggerResizeAfterReady = true;

        const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();

        const screen = await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId={scopeId} />);
        await flushHookEffects();

        expect(screen.tree).toBeTruthy();
        expect(machineTerminalEnsureSpy).toHaveBeenCalledTimes(1);
    });

    it('retries automatically when initial ensure hits rpc method unavailable', async () => {
        machineTerminalEnsureSpy
            .mockRejectedValueOnce(createRpcCallError({
                error: 'RPC method not available',
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }))
            .mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: false });

        const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();

        const screen = await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId={scopeId} />);

        await waitForHomeGovernance(() => {
            expect(machineTerminalEnsureSpy).toHaveBeenCalledTimes(2);
            expect(screen.findByTestId('session-rightpanel-terminal-retry')).toBeNull();
        });
    });

    it('preserves the stream cursor when auto-retrying after a transient read error', async () => {
        machineTerminalEnsureSpy
            .mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: false })
            .mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: true });

        machineTerminalStreamReadSpy.mockReset();
        machineTerminalStreamReadSpy
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 't1',
                events: [{ t: 'data', data: 'hello' }],
                nextCursor: 5,
                done: false,
            })
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'terminal_not_found',
                error: 'terminal_not_found',
            })
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 't1',
                events: [{ t: 'data', data: 'world' }],
                nextCursor: 6,
                done: true,
            });

        const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();

        const screen = await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId={scopeId} />);

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 350));
        });
        await flushHookEffects();

        const thirdReadArgs = machineTerminalStreamReadSpy.mock.calls[2]?.[1];
        expect(thirdReadArgs?.cursor).toBe(5);
        expect(screen.findByTestId('session-rightpanel-terminal-retry')).toBeNull();
    });

    it('preserves the stream cursor when auto-retrying after a stream read timeout', async () => {
        machineTerminalEnsureSpy
            .mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: false })
            .mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: true });

        machineTerminalStreamReadSpy.mockReset();
        machineTerminalStreamReadSpy
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 't1',
                events: [{ t: 'data', data: 'hello' }],
                nextCursor: 5,
                done: false,
            })
            .mockRejectedValueOnce(new Error('operation has timed out'))
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 't1',
                events: [{ t: 'data', data: 'world' }],
                nextCursor: 6,
                done: true,
            });

        const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();

        const screen = await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId={scopeId} />);

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 350));
        });
        await flushHookEffects();

        expect(machineTerminalStreamReadSpy.mock.calls[2]?.[1]?.cursor).toBe(5);

        expect(screen.findByTestId('session-rightpanel-terminal-retry')).toBeNull();
    });

    it('hydrates the transcript and cursor across terminal surface remounts', async () => {
        const firstMountReadBlocked = createDeferred<{
            ok: true;
            terminalId: string;
            events: [];
            nextCursor: number;
            done: boolean;
        }>();
        const secondMountReadBlocked = createDeferred<{
            ok: true;
            terminalId: string;
            events: [];
            nextCursor: number;
            done: boolean;
        }>();
        try {
            machineTerminalEnsureSpy
                .mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: false })
                .mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: true });

            machineTerminalStreamReadSpy.mockReset();
            machineTerminalStreamReadSpy
                .mockResolvedValueOnce({
                    ok: true,
                    terminalId: 't1',
                    events: [{ t: 'data', data: 'hello' }],
                    nextCursor: 5,
                    done: false,
                })
                .mockImplementationOnce(() => firstMountReadBlocked.promise)
                .mockResolvedValueOnce({
                    ok: true,
                    terminalId: 't1',
                    events: [],
                    nextCursor: 5,
                    done: false,
                })
                .mockImplementationOnce(() => secondMountReadBlocked.promise);

            const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();

            const screen = await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId={scopeId} />);

            expect(terminalHandleInstances[0]?.write).toHaveBeenCalledWith('hello');

            await screen.unmount();

            firstMountReadBlocked.resolve({
                ok: true,
                terminalId: 't1',
                events: [],
                nextCursor: 5,
                done: true,
            });
            await flushHookEffects();

            await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId={scopeId} />);

            expect(machineTerminalEnsureSpy).toHaveBeenCalledTimes(2);
            expect(machineTerminalStreamReadSpy.mock.calls[2]?.[1]?.cursor).toBe(5);
            expect(terminalHandleInstances[1]?.write).toHaveBeenCalledWith('hello', { intent: 'replay' });

            secondMountReadBlocked.resolve({
                ok: true,
                terminalId: 't1',
                events: [],
                nextCursor: 5,
                done: true,
            });
            await flushHookEffects();
        } finally {
            firstMountReadBlocked.resolve({
                ok: true,
                terminalId: 't1',
                events: [],
                nextCursor: 5,
                done: true,
            });
            secondMountReadBlocked.resolve({
                ok: true,
                terminalId: 't1',
                events: [],
                nextCursor: 5,
                done: true,
            });
        }
    });

    it('rehydrates cached transcript when the terminal renderer handle changes without remounting the pane hook', async () => {
        const blockedRead = createDeferred<{
            ok: true;
            terminalId: string;
            events: [];
            nextCursor: number;
            done: boolean;
        }>();

        machineTerminalEnsureSpy.mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: false });
        machineTerminalStreamReadSpy
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 't1',
                events: [{ t: 'data', data: 'hello' }],
                nextCursor: 5,
                done: false,
            })
            .mockImplementationOnce(() => blockedRead.promise);

        const SessionEmbeddedTerminalPaneWeb = await loadSessionEmbeddedTerminalPaneWeb();

        const screen = await renderAndFlush(
            <SessionEmbeddedTerminalPaneWeb
                sessionId="s1"
                scopeId={scopeId}
                currentDockLocation="details"
                testIdPrefix="pane-a"
            />,
        );

        expect(terminalHandleInstances[0]?.write).toHaveBeenCalledWith('hello');

        terminalRendererVersion = 1;
        await screen.update(
            <SessionEmbeddedTerminalPaneWeb
                sessionId="s1"
                scopeId={scopeId}
                currentDockLocation="details"
                testIdPrefix="pane-b"
            />,
        );

        await flushHookEffects();

        expect(terminalHandleInstances).toHaveLength(2);
        expect(terminalHandleInstances[1]?.clear).toHaveBeenCalledTimes(1);
        expect(terminalHandleInstances[1]?.write).toHaveBeenCalledWith('hello', { intent: 'replay' });

        blockedRead.resolve({
            ok: true,
            terminalId: 't1',
            events: [],
            nextCursor: 5,
            done: true,
        });
        await flushHookEffects();
    });

    it('clears cached transcript when a reused terminal reconnects without a cached terminal id', async () => {
        const cacheMod = await import('@/components/sessions/terminal/terminalSurfaceStateCache');
        cacheMod.replaceTerminalSurfaceState(`${scopeId}:terminal`, {
            terminalId: null,
            cursor: 5,
            output: 'hello',
            detectedUrl: null,
        });

        machineTerminalEnsureSpy.mockResolvedValueOnce({ ok: true, terminalId: 't1', reused: true });
        machineTerminalStreamReadSpy.mockResolvedValueOnce({
            ok: true,
            terminalId: 't1',
            events: [],
            nextCursor: 5,
            done: true,
        });

        const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();

        await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId={scopeId} />);
        await flushHookEffects();

        const cached = cacheMod.readTerminalSurfaceState(`${scopeId}:terminal`);
        expect(cached).toEqual({
            terminalId: 't1',
            cursor: 0,
            cursorMode: 'legacy-event-cursor',
            output: '',
            detectedUrl: null,
        });
        expect(terminalHandleInstances[0]?.write).not.toHaveBeenCalledWith('hello');
        expect(terminalHandleInstances[0]?.write).not.toHaveBeenCalledWith('\r\n[Reconnected]\r\n');
    });

    it('drops in-flight terminal output that resolves after the user clears the transcript', async () => {
        const delayedRead = createDeferred<{
            ok: true;
            terminalId: string;
            events: Array<{ t: 'data'; data: string }>;
            nextCursor: number;
            done: boolean;
        }>();

        machineTerminalStreamReadSpy.mockReset();
        machineTerminalStreamReadSpy
            .mockImplementationOnce(() => delayedRead.promise)
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 't1',
                events: [],
                nextCursor: 5,
                done: true,
            });

        const SessionRightPanelTerminalViewWeb = await loadSessionRightPanelTerminalViewWeb();

        const screen = await renderAndFlush(<SessionRightPanelTerminalViewWeb sessionId="s1" scopeId={scopeId} />);
        await vi.waitFor(() => {
            expect(machineTerminalStreamReadSpy).toHaveBeenCalled();
        });

        const clearButton = screen.findByTestId('session-rightpanel-terminal-clear');
        expect(clearButton).toBeTruthy();

        await screen.pressByTestIdAsync('session-rightpanel-terminal-clear');

        await act(async () => {
            delayedRead.resolve({
                ok: true,
                terminalId: 't1',
                events: [{ t: 'data', data: 'stale-output' }],
                nextCursor: 5,
                done: false,
            });
        });
        await flushHookEffects();

        expect(terminalHandleInstances[0]?.clear).toHaveBeenCalled();
        expect(terminalHandleInstances[0]?.write).not.toHaveBeenCalledWith('stale-output');
        expect(machineTerminalStreamReadSpy.mock.calls[1]?.[1]?.cursor).toBe(5);
    });
});
