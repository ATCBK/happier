import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { Terminal } from '@xterm/xterm';
import { ExternalActionMachineBootstrapV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';

import { createDeferred, createMachineFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { TerminalStreamReadResponseSchema } from '@happier-dev/protocol/terminal/stream';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { isRecoverableTerminalRpcError, resolveTerminalAutoRetryDelayMs, TERMINAL_AUTO_RETRY_MAX_ATTEMPTS } from '@/components/sessions/terminal/terminalRpcRecovery';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

// Recipient-envelope HTTP is outside this controller journey and must remain unused.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Terminal controller unexpectedly reached the recipient-envelope API'); };
    return {
        createSessionDataKeyEnvelopeClient: unused,
        readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused,
        prepareSessionDataKeyEnvelopesDetached: unused,
    };
});
import type { DaemonTerminalEnsureResponse } from '@happier-dev/protocol';
import type {
    EmbeddedTerminalRendererHandle,
    EmbeddedTerminalWriteBytesResult,
    EmbeddedTerminalWriteCompleteEvent,
} from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import {
    readTerminalSurfaceState,
    replaceTerminalSurfaceState,
} from '@/components/sessions/terminal/terminalSurfaceStateCache';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Response fixtures belong to the external encrypted daemon RPC boundary. The real
// Action admission, policy, machineTerminal codecs and stream carrier all stay live.
const terminalOps = vi.hoisted(() => ({
    ensure: vi.fn(),
    restart: vi.fn(),
    streamRead: vi.fn(),
    streamReadBytes: vi.fn(),
    streamCreditRead: vi.fn(),
    streamAcknowledge: vi.fn(),
    streamSendInput: vi.fn(),
    close: vi.fn(),
    operationGet: vi.fn(),
    operationCancel: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
}));

let servedHomes: Awaited<ReturnType<typeof serveActionHomes>>;
let homeIds: Readonly<{ primary: string; cancel: string; attach: string }>;
let byteStreamEnabled = true;
const queuedWriteResult = { status: 'queued' } satisfies EmbeddedTerminalWriteBytesResult;
const clipboardState = vi.hoisted(() => ({
    setClipboardStringSafe: vi.fn(async () => true),
}));

// Xterm is the platform rendering boundary; the mounted Project pane, terminal
// controller, Action front door, codecs and transport selection remain real.
vi.mock('@/components/terminal/xterm/XtermTerminalView.web', async () => {
    const React = await import('react');
    return { XtermTerminalView: React.forwardRef<EmbeddedTerminalRendererHandle,
        { onReady: (cols: number, rows: number) => void; testID?: string }>((props, ref) => {
        const [output, setOutput] = React.useState('');
        React.useImperativeHandle(ref, () => ({
            write: text => { setOutput(previous => previous + text); return true; },
            writeBytes: input => { setOutput(previous => previous + new TextDecoder().decode(input.bytes)); return true; },
            clear: () => setOutput(''),
            hasSelection: () => false,
            getSelectionText: () => '',
        }), []);
        React.useEffect(() => props.onReady(80, 24), [props.onReady]);
        return React.createElement('TerminalRenderer', { testID: props.testID }, output);
    }) };
});
type EmbeddedTerminalWriteBytesInput = Parameters<NonNullable<EmbeddedTerminalRendererHandle['writeBytes']>>[0];

function rendererWriteComplete(input: EmbeddedTerminalWriteCompleteEvent & Readonly<{
    writeGeneration: number;
}>): EmbeddedTerminalWriteCompleteEvent {
    return input;
}

function readWriteGeneration(value: unknown): number | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const writeGeneration = (value as Readonly<{ writeGeneration?: unknown }>).writeGeneration;
    return typeof writeGeneration === 'number' && Number.isFinite(writeGeneration)
        ? writeGeneration
        : null;
}

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
    const { TerminalStreamReadRequestSchema } = await import('@happier-dev/protocol/terminal/stream');
    const responses = new Map<string, typeof terminalOps.ensure>([
        [ACTION_OPERATION_RPC_METHODS_V2.get, terminalOps.operationGet],
        [ACTION_OPERATION_RPC_METHODS_V1.cancel, terminalOps.operationCancel],
        [RPC_METHODS.DAEMON_TERMINAL_ENSURE, terminalOps.ensure],
        [RPC_METHODS.DAEMON_TERMINAL_RESTART, terminalOps.restart],
        [RPC_METHODS.DAEMON_TERMINAL_STREAM_READ, terminalOps.streamRead],
        [RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES, terminalOps.streamReadBytes],
        [RPC_METHODS.DAEMON_TERMINAL_STREAM_ACK, terminalOps.streamAcknowledge],
        [RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT, terminalOps.streamSendInput],
        [RPC_METHODS.DAEMON_TERMINAL_CLOSE, terminalOps.close],
        [RPC_METHODS.DAEMON_TERMINAL_INPUT, terminalOps.input],
        [RPC_METHODS.DAEMON_TERMINAL_RESIZE, terminalOps.resize],
    ]);
    return {
        machineRpcWithServerScope: (request: Readonly<{ method: string; machineId: string; serverId?: string | null; accountId?: string | null; payload: unknown }>) => {
            if (request.method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES) {
                const payload = TerminalStreamReadRequestSchema.parse(request.payload);
                // This current peer accepts controlCursor on output polls;
                // Account-bound credit-only reads omit it. Do not consume the
                // next scripted output response when only returning credit.
                if (payload.controlCursor === undefined) {
                    return terminalOps.streamCreditRead(request.machineId, payload, {
                        serverId: request.serverId, ...(request.accountId ? { accountId: request.accountId } : {}),
                    });
                }
            }
            const response = responses.get(request.method);
            if (!response) throw new Error(`Unexpected terminal RPC: ${request.method}`);
            return response(request.machineId, request.payload, { serverId: request.serverId, ...(request.accountId ? { accountId: request.accountId } : {}) });
        },
    };
});

// The OS clipboard is external; keep the app's safe-write adapter and selection policy real.
vi.mock('expo-clipboard', () => ({
    setStringAsync: clipboardState.setClipboardStringSafe,
}));

// This native rendering package is unavailable in the source runner and never
// renders in the terminal-controller harness. Keep the actual controller real.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected native Markdown render in terminal controller test'); },
}));

// Resolve the real controller during collection: cold source transforms must
// not consume the lifecycle test's fake-clock phase.
await import('./useMachineTerminalSession');

describe('terminal RPC recovery policy', () => {
    it('recognizes a no-handler refusal returned by terminal Action admission', () => {
        expect(isRecoverableTerminalRpcError({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            error: 'RPC method not available' })).toBe(true);
    });

    it('retains the same policy for thrown RPC errors', () => {
        expect(isRecoverableTerminalRpcError(createRpcCallError({ error: 'RPC method not available',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }))).toBe(true);
    });

    it('recovers from typed transport loss before terminal delivery', () => {
        for (const errorCode of [RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE, 'MACHINE_RPC_TIMEOUT']) {
            expect(isRecoverableTerminalRpcError(createRpcCallError({ error: 'Transport unavailable', errorCode }), 'stream')).toBe(true);
        }
    });

    it('does not treat ambiguous, denied, cancelled or arbitrary admission failures as a no-handler refusal', () => {
        for (const errorCode of [RPC_ERROR_CODES.OUTCOME_UNKNOWN, 'outcome_unknown', 'MACHINE_RPC_TIMEOUT',
            RPC_ERROR_CODES.FORBIDDEN, 'cancelled', 'action_failed']) {
            expect(isRecoverableTerminalRpcError({ ok: false, errorCode, error: 'operation has timed out' })).toBe(false);
        }
    });
});

async function refreshTerminalFeatures(): Promise<void> {
    for (const serverId of Object.values(homeIds)) {
        await getServerFeaturesSnapshot({ serverId, force: true });
    }
}

describe('useMachineTerminalSession', () => {
    beforeEach(async () => {
        byteStreamEnabled = true;
        const settings = {
            featureToggles: { 'terminal.embeddedPty': true },
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: {
                'machines.terminal.open': ['ui'], 'machines.terminal.restart': ['ui'],
                'action.operations.cancel': ['ui'],
            } },
        };
        servedHomes = await serveActionHomes({
            homes: [
                { key: 'cancel', serverUrl: 'https://terminal-cancel.test', accountId: 'terminal-account', settings },
                { key: 'attach', serverUrl: 'https://terminal-attach.test', accountId: 'terminal-account', settings },
                { key: 'primary', serverUrl: 'https://terminal-primary.test', accountId: 'terminal-account', settings },
            ],
            route: request => request.path === '/v1/machines'
                ? Response.json(['machine', 'machine-cancel', 'machine-1'].map(id => ExternalActionMachineBootstrapV1Schema.parse({
                    id, kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
                    installationId: `${id}-installation`, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                    runnerContentKeyBinding: null,
                    access: { custodian: { accountId: 'terminal-account', displayName: 'Terminal owner' },
                        role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                })))
                // Account Machine Actions resolve their target through the batched Machine row read.
                : request.path === '/v1/machines/read-batch' && request.method === 'POST'
                ? createMachineReadBatchResponseFixture(request.body, id => ['machine', 'machine-cancel', 'machine-1'].includes(id)
                    ? createPlainMachineRowFixture({ id, accountId: 'terminal-account' }) : null)
                : request.path === '/v1/features' || request.path === '/v1/features/authenticated'
                ? Response.json(createRootLayoutFeaturesResponse({ features: { terminal: {
                    embeddedPty: { enabled: true }, transport: { byteStream: { enabled: byteStreamEnabled } },
                } } })) : undefined,
        });
        homeIds = { primary: servedHomes.homes.primary!.id, cancel: servedHomes.homes.cancel!.id, attach: servedHomes.homes.attach!.id };
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        await refreshTerminalFeatures();
        terminalOps.ensure.mockReset();
        terminalOps.restart.mockReset();
        terminalOps.streamRead.mockReset();
        terminalOps.streamReadBytes.mockReset();
        terminalOps.streamCreditRead.mockReset();
        terminalOps.streamAcknowledge.mockReset();
        terminalOps.streamSendInput.mockReset();
        terminalOps.close.mockReset();
        terminalOps.operationGet.mockReset();
        terminalOps.operationCancel.mockReset();
        terminalOps.input.mockReset();
        terminalOps.resize.mockReset();
        terminalOps.streamAcknowledge.mockResolvedValue({ ok: true });
        terminalOps.streamCreditRead.mockImplementation((_machineId: string, request: { terminalId: string; byteOffset: number }) =>
            TerminalStreamReadResponseSchema.parse({ ok: true, terminalId: request.terminalId, frames: [],
                nextByteOffset: request.byteOffset, availableByteOffset: request.byteOffset, droppedBeforeByteOffset: 0, done: false }));
        terminalOps.streamSendInput.mockResolvedValue({ ok: true });
        terminalOps.close.mockResolvedValue({ ok: true });
        terminalOps.input.mockResolvedValue({ ok: true });
        terminalOps.resize.mockResolvedValue({ ok: true });
        clipboardState.setClipboardStringSafe.mockReset();
        vi.useFakeTimers();
    });

    afterEach(async () => {
        await standardCleanup();
        vi.useRealTimers();
        await servedHomes.dispose();
    });

    it.each([
        { exitCode: 0, signal: null, outcome: 'Exit code: 0' },
        { exitCode: 17, signal: null, outcome: 'Exit code: 17' },
        { exitCode: 0, signal: 0, outcome: 'Exit code: 0' },
        { exitCode: 0, signal: 15, outcome: 'Stopped' },
        { exitCode: null, signal: 15, outcome: 'Stopped' },
        { exitCode: null, signal: null, outcome: null },
        { exitCode: 0, signal: 0, outcome: 'Stopped', cancelled: true },
        { exitCode: 0, signal: 0, outcome: 'Stopping', stopping: true },
        { exitCode: 0, signal: 0, outcome: 'Stopped', remoteSettlement: 'cancelled' as const },
        { exitCode: 0, signal: 0, outcome: 'Exit code: 0', remoteSettlement: 'succeeded' as const },
        { exitCode: 0, signal: 0, outcome: 'Stopped', stopping: true, remoteSettlement: 'cancelled' as const, phone: true },
        { exitCode: 0, signal: 0, outcome: 'Completed', stopping: true, remoteSettlement: 'succeeded' as const, phone: true },
    ])('renders a finished worker Script with native outcome $exitCode / $signal / $cancelled / $stopping / $remoteSettlement / phone $phone through the real output pane', async ({ exitCode, signal, outcome, cancelled, stopping, remoteSettlement, phone }) => {
        vi.useRealTimers();
        const terminalId = `finished-worker-${exitCode}-${signal}-${cancelled ?? false}-${stopping ?? false}-${remoteSettlement ?? false}`;
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applyMachines([createMachineFixture({ id: 'machine', activeAt: Date.now() })]);
        storage.setState({ projectAccountRows: {
            scope: { serverId: homeIds.primary, accountId: 'terminal-account' }, status: 'ready', coverage: 'complete',
            workspaceRefs: [
                { id: 'source-checkout', serverId: homeIds.primary, machineId: 'source-machine', rootPath: '/source/repo', createdAtMs: 1, projectKey: 'project' },
                { id: 'worker-checkout', serverId: homeIds.primary, machineId: 'machine', rootPath: '/worker/repo', createdAtMs: 1, projectKey: 'project' },
            ], relationships: [], organizations: [], revisionsByPhysicalKey: {},
        } });
        const snapshot = ActionOperationSnapshotV1Schema.parse({
            version: 1, operationId: `worker-output-${terminalId}`, revision: 2, actionId: 'projects.script.run',
            state: stopping || remoteSettlement ? 'running' : cancelled ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed',
            scope: { accountId: 'terminal-account', machineId: remoteSettlement ? 'source-machine' : 'machine' },
            title: 'Script', createdAt: 1, startedAt: 2, ...(stopping || remoteSettlement ? {} : { settledAt: 3 }), cancellation: 'supported',
            ...(exitCode === 0 ? {} : { error: { errorCode: 'project_command_step_failed', error: 'project_command_step_failed' } }),
            domainRef: { kind: 'projectCommand', purpose: 'script', serverId: homeIds.primary,
                machineId: 'machine', workspaceRefId: 'worker-checkout', cwd: '/worker/repo', terminalId,
                sourceWorkspace: { serverId: homeIds.primary, machineId: 'source-machine', workspaceId: 'source-checkout', rootPath: '/source/repo' },
                script: { name: 'fail', source: { kind: 'command', command: 'printf QA_FAIL' } },
                ...(exitCode === null ? {} : { exitCode }) },
        });
        const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
        actionOperationStore.mergeSnapshots({ serverId: homeIds.primary, snapshots: [snapshot] });
        const settlement = createDeferred<unknown>();
        terminalOps.operationGet.mockImplementation(() => settlement.promise);
        terminalOps.streamReadBytes.mockResolvedValue(TerminalStreamReadResponseSchema.parse({ ok: true, terminalId, frames: [
            { t: 'bytes', terminalId, seq: 1, byteOffset: 0, byteLength: 9, encoding: 'base64', data: 'UUFfRkFJTA0K' },
            { t: 'exit', terminalId, byteOffset: 9, exitCode, signal },
        ], nextByteOffset: 9, availableByteOffset: 9, droppedBeforeByteOffset: 0, done: true }));
        const { ProjectCommandOutputPane } = await import('@/components/inbox/actionOperations/ProjectCommandOutputPane');
        const { ProjectScriptRow } = await import('@/components/projects/projectSetup/ProjectScriptRow');
        const { ProjectCommandOutputPage } = await import('@/components/inbox/actionOperations/ProjectCommandOutputPage');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const React = await import('react');
        const outputProps = {
            operation: { serverId: homeIds.primary, observation: 'available', isUnavailableProjection: false, snapshot }, title: 'Script',
        } satisfies React.ComponentProps<typeof ProjectCommandOutputPane>;
        const renderOutput = async () => {
            const rendered = await renderScreen(React.createElement(AppPaneProvider, null, phone
            ? React.createElement(ProjectCommandOutputPage, { serverId: homeIds.primary, operationId: snapshot.operationId,
                name: 'Script', command: 'printf QA_FAIL', onClose: () => {} })
            : stopping
            ? React.createElement(ProjectScriptRow, { testID: 'script', workspace: {
                serverId: homeIds.primary, machineId: 'machine', workspaceId: 'worker-checkout', rootPath: '/worker/repo',
            }, name: 'Script', badge: null, command: 'printf QA_FAIL', portable: false, operation: outputProps.operation,
            idleText: '', pending: false, failureCode: null, compact: false, onRun: () => {} })
            : React.createElement(ProjectCommandOutputPane, outputProps)));
            if (phone) await act(async () => {
                // Native layout is the external boundary that mounts the page's output body.
                const layout = rendered.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')[0];
                if (!layout) throw new Error('Phone output layout is missing');
                layout.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 600 } } });
            });
            return rendered;
        };
        const screen = await renderOutput();
        const cancellation = createDeferred<unknown>();
        if (stopping) {
            if (!phone) await screen.pressByTestIdAsync('script');
            terminalOps.operationCancel.mockImplementation(() => cancellation.promise);
            await screen.pressByTestIdAsync(phone ? 'project-command-output-page.stop' : 'script.run');
            // Pending RPC and accepted Stop both retain Stopping, before the
            // independent settlement observation arrives.
            await vi.waitFor(() => expect(phone ? screen.getTextContent()
                : screen.findByTestId('workspace-embedded-terminal-state-line-text')?.props.children).toContain('Stopping'));
            if (!phone) await act(async () => cancellation.resolve({ kind: 'requested' }));
        }
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('QA_FAIL'));
        if (remoteSettlement) {
            await vi.waitFor(() => expect(terminalOps.operationGet).toHaveBeenCalledWith('source-machine',
                { operationId: snapshot.operationId, waitForTerminal: true }, expect.objectContaining({ serverId: homeIds.primary, accountId: 'terminal-account' })));
            const otherViewer = await renderOutput();
            await vi.waitFor(() => expect(otherViewer.getTextContent()).toContain('QA_FAIL'));
            expect(otherViewer.getTextContent()).not.toContain('Exit code:');
            expect(screen.getTextContent()).not.toContain('Exit code:');
            expect(terminalOps.operationGet).toHaveBeenCalledTimes(1);
            await act(async () => settlement.resolve({ kind: 'found', operation: ActionOperationSnapshotV1Schema.parse({
                ...snapshot, revision: 3, state: remoteSettlement, settledAt: 3,
            }) }));
            await vi.waitFor(() => expect(otherViewer.getTextContent()).toContain(outcome));
            // The canonical read settles both viewers even while the initiating
            // phone's cancel RPC has not acknowledged. Native exit alone did not settle it.
            if (phone) {
                await vi.waitFor(() => expect(screen.getTextContent()).toContain(outcome));
                expect(screen.getTextContent()).not.toContain('Stopping');
                await act(async () => cancellation.resolve({ kind: 'requested' }));
                expect(screen.getTextContent()).toContain(outcome);
            }
            await otherViewer.unmount();
        }
        expect(screen.findByTestId('workspace-embedded-terminal-state-card')).toBeNull();
        if (outcome) await vi.waitFor(() => expect(screen.getTextContent()).toContain(outcome));
        if (exitCode === null || signal || cancelled || stopping || remoteSettlement === 'cancelled') expect(screen.getTextContent()).not.toContain('Exit code:');
        if (remoteSettlement) {
            expect([...actionOperationStore.getSnapshot().operationsByKey.values()].find(value => value.snapshot.operationId === snapshot.operationId)?.snapshot.state).toBe(remoteSettlement);
        }
        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith('machine', expect.objectContaining({ terminalId }), expect.objectContaining({ serverId: homeIds.primary }));
        if (stopping) {
            if (phone) {
                await screen.unmount();
                return;
            }
            await act(async () => settlement.resolve({ kind: 'found', operation: ActionOperationSnapshotV1Schema.parse({
                ...snapshot, revision: 3, state: 'cancelled', settledAt: 3,
            }) }));
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('Stopped'));
            expect(screen.getTextContent()).not.toContain('Exit code:');
            await screen.unmount();
            return;
        }
        await screen.unmount();
        // Returning from phone width remounts the inline pane. Its retained bytes
        // and native outcome must be visible before the daemon answers the new read.
        const replay = createDeferred<ReturnType<typeof TerminalStreamReadResponseSchema.parse>>();
        terminalOps.streamReadBytes.mockImplementation(() => replay.promise);
        const returned = await renderOutput();
        const { EmbeddedTerminalPane } = await import('@/components/terminal/embedded/EmbeddedTerminalPane');
        expect(returned.findByType(EmbeddedTerminalPane).props.controller).toMatchObject({
            status: 'exited', exitCode, exitSignal: signal,
        });
        expect(returned.getTextContent()).toContain('QA_FAIL');
        expect(returned.findByTestId('workspace-embedded-terminal-state-card')).toBeNull();
        if (outcome) expect(returned.getTextContent()).toContain(outcome);
        await act(async () => replay.resolve(TerminalStreamReadResponseSchema.parse({ ok: true, terminalId, frames: [
            { t: 'exit', terminalId, byteOffset: 9, exitCode, signal },
        ], nextByteOffset: 9, availableByteOffset: 9, droppedBeforeByteOffset: 0, done: true })));
        expect(returned.getTextContent().match(/QA_FAIL/g)).toHaveLength(1);
        await returned.unmount();
        expect(terminalOps.ensure).not.toHaveBeenCalled();
        expect(terminalOps.restart).not.toHaveBeenCalled();
        expect(terminalOps.close).not.toHaveBeenCalled();
    });

    it('does not restore a finished borrowed surface before its Account scope is proven', async () => {
        const terminalKey = 'borrowed-other-account';
        replaceTerminalSurfaceState(terminalKey, {
            terminalId: 'borrowed-other-account-pty', cursor: 7, output: 'private', detectedUrl: null,
            exit: { exitCode: 17, signal: null, scope: { serverId: homeIds.primary, accountId: 'another-account' } },
        });
        const read = createDeferred<unknown>();
        terminalOps.streamReadBytes.mockImplementation(() => read.promise);
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const firstStates: Array<Readonly<{ status: string; exitCode: number | null }>> = [];
        const hook = await renderHook(() => {
            const controller = useMachineTerminalSession({ machineId: 'machine', serverId: homeIds.primary, cwd: '/repo',
                terminalKey, terminalRef, attachedTerminalId: 'borrowed-other-account-pty', readOnly: true });
            firstStates.push({ status: controller.status, exitCode: controller.exitCode });
            return controller;
        }, { flushOptions: { cycles: 1, turns: 1 } });
        expect(firstStates[0]).toEqual({ status: 'connecting', exitCode: null });
        expect(terminalRef.current.write).not.toHaveBeenCalledWith('private', expect.anything());
        await hook.unmount();
    });

    it('reads borrowed output with independent credit identities while refusing all process mutations', async () => {
        terminalOps.streamAcknowledge.mockResolvedValue({ ok: true });
        terminalOps.streamSendInput.mockResolvedValue({ ok: true });
        terminalOps.streamReadBytes.mockResolvedValue({ ok: true, terminalId: 'borrowed', frames: [{
            t: 'bytes', terminalId: 'borrowed', seq: 1, byteOffset: 0, byteLength: 3, encoding: 'base64', data: 'b3V0',
        }], nextByteOffset: 3, availableByteOffset: 3, droppedBeforeByteOffset: 0, done: true });
        const renderer = { write: vi.fn(), writeBytes: vi.fn(() => true), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle;
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const createView = (terminalKey: string) => {
            const terminalRef = { current: renderer };
            return renderHook(() => useMachineTerminalSession({
                machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey,
                terminalRef, attachedTerminalId: 'borrowed', readOnly: true, closeOnUnmount: true,
            }), { flushOptions: { cycles: 1, turns: 1 } });
        };
        const first = await createView('borrowed-view-one');
        const second = await createView('borrowed-view-two');
        expect(first.getCurrent().readOnly).toBe(true);
        expect(second.getCurrent().readOnly).toBe(true);
        await act(async () => {
            first.getCurrent().onReady(80, 24);
            first.getCurrent().onInput('echo forbidden\r');
            expect(await first.getCurrent().onPaste('echo mutable')).toMatchObject({ kind: 'ignore' });
            first.getCurrent().onResize(120, 40);
            first.getCurrent().requestRestart();
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(renderer.writeBytes).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 'borrowed', byteOffset: 0 }));
        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith('machine', expect.objectContaining({ terminalId: 'borrowed' }), expect.objectContaining({ serverId: homeIds.primary }));
        const rendererIds = new Set(terminalOps.streamReadBytes.mock.calls.map((call) => (call[1] as { rendererId?: string }).rendererId));
        expect(rendererIds.size).toBe(2);
        expect(rendererIds.has('embedded-terminal')).toBe(false);
        await first.unmount();
        await second.unmount();
        expect(terminalOps.ensure).not.toHaveBeenCalled();
        expect(terminalOps.restart).not.toHaveBeenCalled();
        expect(terminalOps.streamSendInput).not.toHaveBeenCalled();
        expect(terminalOps.input).not.toHaveBeenCalled();
        expect(terminalOps.resize).not.toHaveBeenCalled();
        expect(terminalOps.close).not.toHaveBeenCalled();
    });

    it.each([undefined, 'observed'])('waits without an error or terminal RPCs for observed Machine presence, then attaches (existing terminal: %s)', async (attachedTerminalId) => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'observed', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({ ok: true, terminalId: 'observed', frames: [], nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true });
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        let reachable: boolean | null = null;
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey: 'unobserved-machine',
            terminalRef, machineReachable: reachable, machineRpcTargetAvailable: true,
            attachedTerminalId,
        }));
        await act(async () => hook.getCurrent().onReady(80, 24));
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        for (const rpc of Object.values(terminalOps)) expect(rpc).not.toHaveBeenCalled();
        expect(hook.getCurrent().status).toBe(attachedTerminalId ? 'connecting' : 'not-open');
        expect(hook.getCurrent().error).toBeNull();
        reachable = true;
        await hook.rerender();
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.ensure).toHaveBeenCalledTimes(attachedTerminalId ? 0 : 1);
        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith('machine', expect.objectContaining({ terminalId: 'observed' }), expect.any(Object));
        expect(hook.getCurrent().terminalId).toBe('observed');
        expect(hook.getCurrent().error).toBeNull();
        await hook.unmount();
    });

    it('keeps a workspace terminal waiting while its retained Machine presence is unknown, then opens on observation', async () => {
        const React = await import('react');
        const { storage } = await import('@/sync/domains/state/storage');
        const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
        const { withdrawMachinePresenceForScope } = await import('@/sync/domains/machines/reachability/machineReachability');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { WorkspaceEmbeddedTerminalPane } = await import('@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane');
        const { EmbeddedTerminalPane } = await import('@/components/terminal/embedded/EmbeddedTerminalPane');
        storage.getState().applyMachines([createMachineFixture({ id: 'machine', activeAt: Date.now() })]);
        // Model the real transport-withdrawal edge: the row remains, its presence needs fresh observation.
        withdrawMachinePresenceForScope({ serverId: homeIds.primary, accountId: 'terminal-account' });
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'workspace-observed', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({ ok: true, terminalId: 'workspace-observed', frames: [],
            nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true });
        const screen = await renderScreen(React.createElement(AppPaneProvider, null,
            React.createElement(WorkspaceEmbeddedTerminalPane, {
                scopeId: 'workspace-presence', machineId: 'machine', rootPath: '/repo',
                serverId: homeIds.primary, terminalKey: 'workspace-presence',
            })));
        expect(screen.findByType(EmbeddedTerminalPane).props.controller).toMatchObject({ status: 'not-open', error: null });
        for (const rpc of Object.values(terminalOps)) expect(rpc).not.toHaveBeenCalled();
        await act(async () => { observeMachinePresenceForTest({ serverId: homeIds.primary, accountId: 'terminal-account' }, ['machine']); });
        await vi.waitFor(() => expect(terminalOps.streamReadBytes).toHaveBeenCalledWith('machine',
            expect.objectContaining({ terminalId: 'workspace-observed' }), expect.any(Object)));
        expect(screen.findByType(EmbeddedTerminalPane).props.controller.error).toBeNull();
        await screen.unmount();
    });

    it('issues an explicit Retry while the machine is unreachable', async () => {
        const ensured = createDeferred<DaemonTerminalEnsureResponse>();
        terminalOps.ensure.mockReturnValue(ensured.promise);
        terminalOps.streamReadBytes.mockResolvedValue({ ok: true, terminalId: 'retried', frames: [], nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true });
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        let reachable = false;
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey: 'unreachable-retry',
            terminalRef, machineReachable: reachable, machineRpcTargetAvailable: reachable,
        }));
        await act(async () => hook.getCurrent().onReady(80, 24));
        expect(terminalOps.ensure).not.toHaveBeenCalled();
        await act(async () => hook.getCurrent().retryConnect());
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.ensure).toHaveBeenCalledWith('machine', expect.objectContaining({ cwd: '/repo' }), expect.any(Object));
        reachable = true;
        await hook.rerender();
        expect(terminalOps.ensure).toHaveBeenCalledTimes(1);
        await act(async () => ensured.resolve({ ok: true, terminalId: 'retried', reused: false }));
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith('machine', expect.objectContaining({ terminalId: 'retried' }), expect.any(Object));
        expect(hook.getCurrent().error).toBeNull();
        await hook.unmount();
    });

    it('settles terminal disposal when its close RPC loses transport', async () => {
        vi.useRealTimers();
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'closing', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({ ok: true, terminalId: 'closing', frames: [], nextByteOffset: 0,
            availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true });
        const closing = createDeferred<{ ok: true }>();
        terminalOps.close.mockReturnValue(closing.promise);
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => { unhandled.push(error); };
        process.on('unhandledRejection', onUnhandled);
        try {
            const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
            const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
            const hook = await renderHook(() => useMachineTerminalSession({
                machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey: 'close-transport',
                terminalRef, closeOnUnmount: true,
            }));
            await act(async () => hook.getCurrent().onReady(80, 24));
            await vi.waitFor(() => expect(hook.getCurrent().status).toBe('exited'));
            await hook.unmount();
            expect(terminalOps.close).toHaveBeenCalled();
            closing.reject(createRpcCallError({ error: 'RPC target unavailable', errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE }));
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setImmediate(resolve));
            expect(unhandled).toEqual([]);
        } finally { process.off('unhandledRejection', onUnhandled); }
    });

    it.each([RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE, 'MACHINE_RPC_TIMEOUT'])(
        'uses the existing finite recovery budget for a stream %s failure', async errorCode => {
            terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'recover-stream', reused: true });
            terminalOps.streamReadBytes.mockRejectedValue(createRpcCallError({ error: 'Stream unavailable', errorCode }));
            terminalOps.streamRead.mockRejectedValue(createRpcCallError({ error: 'Stream unavailable', errorCode }));
            const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
            const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
            const hook = await renderHook(() => useMachineTerminalSession({
                machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey: `stream-recovery:${errorCode}`, terminalRef,
            }));
            await act(async () => hook.getCurrent().onReady(80, 24));
            await flushHookEffects({ cycles: 4, turns: 2 });
            expect(hook.getCurrent().status).toBe('connecting');
            for (let attempt = 1; attempt <= TERMINAL_AUTO_RETRY_MAX_ATTEMPTS; attempt++) {
                await act(async () => { await vi.advanceTimersByTimeAsync(resolveTerminalAutoRetryDelayMs(attempt)); });
                await flushHookEffects({ cycles: 4, turns: 2 });
            }
            expect(hook.getCurrent().status).toBe('error');
            expect(hook.getCurrent().error).toBe('terminal_rpc_target_unavailable');
            const settledReads = terminalOps.streamReadBytes.mock.calls.length;
            await act(async () => { await vi.advanceTimersByTimeAsync(resolveTerminalAutoRetryDelayMs(TERMINAL_AUTO_RETRY_MAX_ATTEMPTS)); });
            await flushHookEffects({ cycles: 4, turns: 2 });
            expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(settledReads);
            await hook.unmount();
        });

    it('attributes an owned terminal ensure to its Session', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'attributed', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({ ok: true, terminalId: 'attributed', frames: [], nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true });
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        const hook = await renderHook(() => useMachineTerminalSession({ machineId: 'machine', cwd: '/repo', terminalKey: 'attribution', terminalRef, sessionId: 'own-session' }));
        await act(async () => hook.getCurrent().onReady(80, 24));
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.ensure).toHaveBeenCalledWith('machine', expect.objectContaining({ sessionId: 'own-session' }), expect.any(Object));
        await hook.unmount();
    });

    it('closes a late ensure after unmount when terminal cleanup is requested', async () => {
        const ensured = createDeferred<DaemonTerminalEnsureResponse>();
        terminalOps.ensure.mockReturnValue(ensured.promise);
        terminalOps.close.mockResolvedValue({ ok: true });
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        const launch = { kind: 'agent_login', agentId: 'codex' } as const;
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine-cancel', serverId: homeIds.cancel, cwd: null, launch,
            terminalKey: 'provider-login:machine-cancel:codex', terminalRef, closeOnUnmount: true,
        }));
        await act(async () => { hook.getCurrent().onReady(80, 24); });
        expect(terminalOps.ensure).toHaveBeenCalled();
        await hook.unmount();
        await act(async () => {
            ensured.resolve({ ok: true, terminalId: 'late-cancel-terminal', reused: false });
        });
        await vi.waitFor(() => expect(terminalOps.close).toHaveBeenCalledWith('machine-cancel', { terminalId: 'late-cancel-terminal' },
            { serverId: homeIds.cancel, accountId: 'terminal-account' }));
        expect(terminalOps.streamReadBytes).not.toHaveBeenCalled();
        expect(readTerminalSurfaceState('provider-login:machine-cancel:codex')?.terminalId ?? null).toBeNull();
    });

    it('keeps the stable terminal key and Home on a typed session-attach request', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-attach', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-attach',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: true,
        });

        const terminalRef = {
            current: {
                write: vi.fn(),
                writeBytes: vi.fn(),
                clear: vi.fn(),
            } satisfies EmbeddedTerminalRendererHandle,
        };
        const launch = { kind: 'session_attach', sessionId: 'session-1' } as const;

        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                serverId: homeIds.attach,
                sessionId: 'session-1',
                closeOnUnmount: true,
                cwd: null,
                launch,
                terminalKey: 'session:session-1:attached',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.ensure).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            terminalKey: 'session:session-1:attached',
            launch: { kind: 'session_attach', sessionId: 'session-1' },
        }), { serverId: homeIds.attach, accountId: 'terminal-account' });
        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith('machine-1', expect.any(Object), expect.objectContaining({ serverId: homeIds.attach }));

        terminalOps.streamSendInput.mockResolvedValue({ ok: true });
        await act(async () => {
            hook.getCurrent().onInput('pwd\r');
        });
        await flushHookEffects({ cycles: 2, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.streamSendInput).toHaveBeenCalledWith(
            'machine-1',
            { terminalId: 'term-attach', event: { t: 'text', text: 'pwd\r' } },
            expect.objectContaining({ serverId: homeIds.attach }),
        );

        terminalOps.restart.mockResolvedValue({ ok: true, terminalId: 'term-restarted', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true, terminalId: 'term-restarted', frames: [], nextByteOffset: 0,
            availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true,
        });
        await act(async () => hook.getCurrent().requestRestart());
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.restart).toHaveBeenCalledWith('machine-1', expect.objectContaining({ sessionId: 'session-1' }), { serverId: homeIds.attach, accountId: 'terminal-account' });

        await hook.unmount();
        expect(terminalOps.close).toHaveBeenCalledWith('machine-1', { terminalId: 'term-restarted' }, { serverId: homeIds.attach, accountId: 'terminal-account' });
    });

    it('owns bounded title, bell, and user-selection copy policy at the session controller', async () => {
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            clear: vi.fn(),
            hasSelection: () => true,
            getSelectionText: () => 'selected terminal output',
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: null,
                cwd: null,
                terminalKey: 'session:terminal-presentation-policy',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );
        const controller = hook.getCurrent() as typeof hook extends { getCurrent: () => infer T } ? T & Readonly<{
            terminalTitle?: string | null;
            terminalBell?: string | null;
            copySelection?: (request?: Readonly<{ source: 'user-selection' | 'remote-osc52'; text: string }>) => void;
        }> : never;

        await act(async () => {
            controller.onTitle?.(`status\u001b[31m${'x'.repeat(160)}`);
            controller.onBell?.('ding\u0007\u001b[31m');
            controller.copySelection?.();
            controller.copySelection?.({ source: 'remote-osc52', text: 'remote clipboard payload' });
        });

        const updatedController = hook.getCurrent() as typeof controller;
        expect(updatedController.terminalTitle).toHaveLength(120);
        expect(updatedController.terminalTitle).toContain('status[31m');
        expect(updatedController.terminalTitle).not.toContain('\u001b');
        expect(updatedController.terminalBell).toBe('ding[31m');
        expect(clipboardState.setClipboardStringSafe).toHaveBeenCalledWith('selected terminal output');
        expect(clipboardState.setClipboardStringSafe).not.toHaveBeenCalledWith('remote clipboard payload');

        await hook.unmount();
    });

    it('credits synchronously accepted byte writes without accepting an unsolicited renderer completion', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-1', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-1',
            frames: [{
                t: 'bytes',
                terminalId: 'term-1',
                seq: 1,
                byteOffset: 0,
                byteLength: 3,
                encoding: 'base64',
                data: 'QUJD',
            }],
            nextByteOffset: 3,
            availableByteOffset: 3,
            droppedBeforeByteOffset: 0,
            done: true,
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s1:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(renderer.writeBytes).toHaveBeenCalledWith(expect.objectContaining({
            terminalId: 'term-1',
            byteOffset: 0,
            bytes: new Uint8Array([65, 66, 67]),
        }));
        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ terminalId: 'term-1', byteOffset: 0 }),
            expect.any(Object),
        );
        expect(terminalOps.streamRead).not.toHaveBeenCalled();
        expect(renderer.write).not.toHaveBeenCalledWith('ABC');

        expect(terminalOps.streamAcknowledge).not.toHaveBeenCalled();
        expect(terminalOps.streamCreditRead).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                terminalId: 'term-1',
                byteOffset: 3,
                ackedByteOffset: 3,
                rendererId: 'embedded-terminal',
            }),
            expect.objectContaining({ serverId: homeIds.primary, accountId: 'terminal-account' }),
        );

        const acknowledgementsBeforeUnsolicitedCompletion = terminalOps.streamCreditRead.mock.calls.length;
        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-1',
                seq: 1,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: 0,
            }));
        });

        expect(terminalOps.streamCreditRead).toHaveBeenCalledTimes(acknowledgementsBeforeUnsolicitedCompletion);

        await hook.unmount();
    });

    it('does not advance the byte replay cursor when the renderer rejects a byte write', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-retry', reused: false });
        terminalOps.streamReadBytes
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-retry',
                frames: [{
                    t: 'bytes',
                    terminalId: 'term-retry',
                    seq: 1,
                    byteOffset: 0,
                    byteLength: 3,
                    encoding: 'base64',
                    data: 'QUJD',
                }],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            })
            .mockResolvedValue({
                ok: true,
                terminalId: 'term-retry',
                frames: [],
                nextByteOffset: 0,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(() => false),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-retry:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 5, turns: 2, runOnlyPendingTimers: true });

        expect(renderer.writeBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamReadBytes).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            expect.objectContaining({ terminalId: 'term-retry', byteOffset: 0 }),
            expect.any(Object),
        );
        expect(terminalOps.streamReadBytes).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            expect.objectContaining({ terminalId: 'term-retry', byteOffset: 0 }),
            expect.any(Object),
        );

        await hook.unmount();
    });

    it('waits for queued native write ACK before advancing the byte replay cursor', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-native-queue', reused: false });
        terminalOps.streamReadBytes
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-native-queue',
                frames: [{
                    t: 'bytes',
                    terminalId: 'term-native-queue',
                    seq: 5,
                    byteOffset: 0,
                    byteLength: 3,
                    encoding: 'base64',
                    data: 'QUJD',
                }],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            })
            .mockResolvedValue({
                ok: true,
                terminalId: 'term-native-queue',
                frames: [],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            });

        const writeBytes = vi.fn((_input: EmbeddedTerminalWriteBytesInput) => queuedWriteResult);
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes,
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-native-queue:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(renderer.writeBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-queue',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 99,
                writeGeneration: 0,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamCreditRead).not.toHaveBeenCalled();

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-queue',
                seq: 5,
                byteOffset: 0,
                byteLength: 2,
                ackedByteOffset: 3,
                writeGeneration: 0,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamCreditRead).not.toHaveBeenCalled();

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-queue',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: 1,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamCreditRead).not.toHaveBeenCalled();

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-queue',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: 0,
            }));
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            expect.objectContaining({ terminalId: 'term-native-queue', byteOffset: 3 }),
            expect.any(Object),
        );
        expect(terminalOps.streamCreditRead).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                terminalId: 'term-native-queue',
                byteOffset: 3,
                ackedByteOffset: 3,
                rendererId: 'embedded-terminal',
            }),
            expect.objectContaining({ serverId: homeIds.primary, accountId: 'terminal-account' }),
        );

        const acknowledgedBeforeClear = terminalOps.streamCreditRead.mock.calls.length;
        await act(async () => {
            hook.getCurrent().clearTerminal();
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-queue',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: 0,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamCreditRead).toHaveBeenCalledTimes(acknowledgedBeforeClear);

        await hook.unmount();
    });

    it('releases a rejected queued native write and retries its original bytes without ACK credit', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-native-reject', reused: false });
        const byteFrame = {
            t: 'bytes' as const,
            terminalId: 'term-native-reject',
            seq: 5,
            byteOffset: 0,
            byteLength: 3,
            encoding: 'base64' as const,
            data: 'QUJD',
        };
        terminalOps.streamReadBytes
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-native-reject',
                frames: [byteFrame],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            })
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-native-reject',
                frames: [byteFrame],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            });

        const writeBytes = vi.fn((_input: EmbeddedTerminalWriteBytesInput) => queuedWriteResult);
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes,
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-native-reject:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        const firstWrite = writeBytes.mock.calls[0]?.[0];
        const writeGeneration = readWriteGeneration(firstWrite);
        expect(firstWrite).toEqual(expect.objectContaining({
            terminalId: 'term-native-reject',
            seq: 5,
            byteOffset: 0,
            bytes: new Uint8Array([65, 66, 67]),
        }));
        expect(writeGeneration).not.toBeNull();

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-reject',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 0,
                writeGeneration: writeGeneration!,
            }));
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            expect.objectContaining({ terminalId: 'term-native-reject', byteOffset: 0 }),
            expect.any(Object),
        );
        expect(writeBytes).toHaveBeenCalledTimes(2);
        expect(writeBytes.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
            terminalId: 'term-native-reject',
            seq: 5,
            byteOffset: 0,
            bytes: new Uint8Array([65, 66, 67]),
        }));
        expect(terminalOps.streamCreditRead).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('delivers control frames after a matching queued write completion without rereading them', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-queued-url', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-queued-url',
            frames: [
                {
                    t: 'bytes',
                    terminalId: 'term-queued-url',
                    seq: 5,
                    byteOffset: 0,
                    byteLength: 3,
                    encoding: 'base64',
                    data: 'QUJD',
                },
                {
                    t: 'url',
                    terminalId: 'term-queued-url',
                    byteOffset: 3,
                    url: 'https://example.com/login',
                    kind: 'auth',
                },
            ],
            nextByteOffset: 3,
            availableByteOffset: 3,
            droppedBeforeByteOffset: 0,
            done: true,
        });

        const writeBytes = vi.fn((_input: EmbeddedTerminalWriteBytesInput) => queuedWriteResult);
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes,
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-queued-url:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        const writeGeneration = readWriteGeneration(writeBytes.mock.calls[0]?.[0]);
        expect(writeGeneration).not.toBeNull();
        expect(hook.getCurrent().detectedUrl).toBeNull();

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-queued-url',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: writeGeneration!,
            }));
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(hook.getCurrent().detectedUrl).toEqual({
            t: 'url',
            url: 'https://example.com/login',
            kind: 'auth',
            suggestOpen: undefined,
        });
        expect(terminalOps.streamCreditRead).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                terminalId: 'term-queued-url',
                byteOffset: 3,
                ackedByteOffset: 3,
                surfaceEpoch: writeGeneration,
            }),
            expect.objectContaining({ serverId: homeIds.primary, accountId: 'terminal-account' }),
        );
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-queued-url',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: writeGeneration!,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);

        await hook.unmount();
    });

    it('rejects a same-identity parser completion from before terminal restart', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-restart-generation', reused: false });
        terminalOps.restart.mockResolvedValue({ ok: true, terminalId: 'term-restart-generation', reused: false });
        terminalOps.streamReadBytes
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-restart-generation',
                frames: [{
                    t: 'bytes',
                    terminalId: 'term-restart-generation',
                    seq: 5,
                    byteOffset: 0,
                    byteLength: 3,
                    encoding: 'base64',
                    data: 'QUJD',
                }],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            })
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-restart-generation',
                frames: [{
                    t: 'bytes',
                    terminalId: 'term-restart-generation',
                    seq: 5,
                    byteOffset: 0,
                    byteLength: 3,
                    encoding: 'base64',
                    data: 'QUJD',
                }],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            })
            .mockResolvedValue({
                ok: true,
                terminalId: 'term-restart-generation',
                frames: [],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            });

        const writeBytes = vi.fn((_input: EmbeddedTerminalWriteBytesInput) => queuedWriteResult);
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes,
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-restart-generation:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        const initialGeneration = readWriteGeneration(writeBytes.mock.calls[0]?.[0]);
        expect(initialGeneration).not.toBeNull();

        await act(async () => {
            hook.getCurrent().requestRestart();
        });
        await flushHookEffects({ cycles: 5, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.restart).toHaveBeenCalledTimes(1);
        expect(writeBytes).toHaveBeenCalledTimes(2);
        const restartedGeneration = readWriteGeneration(writeBytes.mock.calls[1]?.[0]);
        expect(restartedGeneration).not.toBeNull();
        expect(restartedGeneration).not.toBe(initialGeneration);

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-restart-generation',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: initialGeneration!,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamCreditRead).not.toHaveBeenCalled();
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(2);

        await hook.unmount();
    });

    it('keeps the legacy event cursor and suppresses byte ACKs after a queued compatibility write', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-legacy-queue', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_byte_stream_unavailable',
            message: 'older daemon',
        });
        terminalOps.streamRead
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-legacy-queue',
                events: [{ t: 'data', data: 'legacy' }],
                nextCursor: 1,
                done: false,
            })
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-legacy-queue',
                events: [],
                nextCursor: 1,
                done: true,
            });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn((_input: EmbeddedTerminalWriteBytesInput) => queuedWriteResult),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-legacy-queue:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamRead).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            { terminalId: 'term-legacy-queue', cursor: 0, maxBytes: undefined, maxEvents: undefined },
            expect.any(Object),
        );

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-legacy-queue',
                seq: 0,
                byteOffset: 0,
                byteLength: 6,
                ackedByteOffset: 6,
                writeGeneration: 0,
            }));
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamRead).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            { terminalId: 'term-legacy-queue', cursor: 1, maxBytes: undefined, maxEvents: undefined },
            expect.any(Object),
        );
        expect(terminalOps.streamCreditRead).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('clears cached preview output when it cannot be tied to the ensured terminal id', async () => {
        const terminalKey = 'session:s-stale:terminal';
        replaceTerminalSurfaceState(terminalKey, {
            terminalId: null,
            cursor: 42,
            output: 'stale cached terminal output',
            detectedUrl: null,
        });
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-fresh', reused: true });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-fresh',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: true,
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey,
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(renderer.clear).toHaveBeenCalled();
        expect(renderer.write).not.toHaveBeenCalledWith('stale cached terminal output');
        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ terminalId: 'term-fresh', byteOffset: 0 }),
            expect.any(Object),
        );

        await hook.unmount();
    });

    it('resets a cached byte cursor when disabled terminal streaming selects legacy replay', async () => {
        const terminalKey = 'session:s-legacy-cursor-mismatch:terminal';
        byteStreamEnabled = false;
        await refreshTerminalFeatures();
        replaceTerminalSurfaceState(terminalKey, {
            terminalId: 'term-legacy-cursor-mismatch',
            cursor: 42,
            cursorMode: 'byte-offset',
            output: 'cached byte preview',
            detectedUrl: null,
        });
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-legacy-cursor-mismatch', reused: true });
        terminalOps.streamRead.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-legacy-cursor-mismatch',
            events: [],
            nextCursor: 0,
            done: true,
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey,
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamRead).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ terminalId: 'term-legacy-cursor-mismatch', cursor: 0 }),
            expect.any(Object),
        );
        expect(terminalOps.streamReadBytes).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('records a legacy cursor mode when carrier fallback keeps the numeric cursor at zero', async () => {
        const terminalKey = 'session:s-legacy-mode-transition:terminal';
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-legacy-mode-transition', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_byte_stream_unavailable',
            message: 'older daemon',
        });
        terminalOps.streamRead.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-legacy-mode-transition',
            events: [],
            nextCursor: 0,
            done: true,
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey,
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(readTerminalSurfaceState(terminalKey)).toEqual(expect.objectContaining({
            terminalId: 'term-legacy-mode-transition',
            cursor: 0,
            cursorMode: 'legacy-event-cursor',
        }));

        await hook.unmount();
    });

    it('aborts a partial OSC at a stream gap so the marker and next prompt remain visible', async () => {
        byteStreamEnabled = false;
        await refreshTerminalFeatures();
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-osc-gap', reused: false });
        terminalOps.streamRead.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-osc-gap',
            events: [
                { t: 'data', data: '\u001b]0;unfinished title' },
                { t: 'gap', droppedBefore: 2 },
                { t: 'data', data: 'next prompt$ ' },
            ],
            nextCursor: 3,
            done: true,
        });
        const terminal = new Terminal({ cols: 80, rows: 24 });
        const terminalRef = { current: {
            write: (data: string) => terminal.write(data),
            clear: () => terminal.clear(),
        } satisfies EmbeddedTerminalRendererHandle };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine-1',
            cwd: '/repo',
            terminalKey: 'session:osc-gap:terminal',
            terminalRef,
        }), { flushOptions: { cycles: 1, turns: 1 } });
        try {
            await act(async () => hook.getCurrent().onReady(80, 24));
            await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
            const text = Array.from({ length: terminal.buffer.active.length }, (_, index) => (
                terminal.buffer.active.getLine(index)?.translateToString(true) ?? ''
            )).join('\n');
            expect(text).toContain('[Output truncated]');
            expect(text).toContain('next prompt$');
        } finally {
            await hook.unmount();
            terminal.dispose();
        }
    });

    it('replaces same-mode cached preview text when daemon replay begins', async () => {
        const terminalKey = 'session:s-preview-replacement:terminal';
        replaceTerminalSurfaceState(terminalKey, {
            terminalId: 'term-preview-replacement',
            cursor: 3,
            cursorMode: 'byte-offset',
            output: 'cached preview',
            detectedUrl: null,
        });
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-preview-replacement', reused: true });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-preview-replacement',
            frames: [{
                t: 'bytes',
                terminalId: 'term-preview-replacement',
                seq: 2,
                byteOffset: 3,
                byteLength: 5,
                encoding: 'base64',
                data: 'RlJFU0g=',
            }],
            nextByteOffset: 8,
            availableByteOffset: 8,
            droppedBeforeByteOffset: 0,
            done: true,
        });

        const callOrder: string[] = [];
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn((data: string) => {
                callOrder.push(`write:${data}`);
            }),
            writeBytes: vi.fn((input) => {
                callOrder.push(`bytes:${new TextDecoder().decode(input.bytes)}`);
            }),
            clear: vi.fn(() => {
                callOrder.push('clear');
            }),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey,
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ terminalId: 'term-preview-replacement', byteOffset: 3 }),
            expect.any(Object),
        );
        const previewIndex = callOrder.indexOf('write:cached preview');
        const replayClearIndex = callOrder.lastIndexOf('clear');
        const replayBytesIndex = callOrder.indexOf('bytes:FRESH');
        expect(previewIndex).toBeGreaterThanOrEqual(0);
        expect(replayClearIndex).toBeGreaterThan(previewIndex);
        expect(replayClearIndex).toBeLessThan(replayBytesIndex);
        expect(readTerminalSurfaceState(terminalKey)).toEqual(expect.objectContaining({
            terminalId: 'term-preview-replacement',
            cursor: 8,
            cursorMode: 'byte-offset',
            output: 'FRESH',
        }));

        await hook.unmount();
    });

    it('hydrates a replacement renderer when its ready event follows a child-local fallback', async () => {
        const terminalKey = 'session:s-renderer-fallback:terminal';
        replaceTerminalSurfaceState(terminalKey, {
            terminalId: 'term-renderer-fallback',
            cursor: 14,
            cursorMode: 'byte-offset',
            output: 'cached output',
            detectedUrl: null,
        });
        terminalOps.ensure.mockResolvedValue({
            ok: true,
            terminalId: 'term-renderer-fallback',
            reused: true,
        });
        terminalOps.streamReadBytes.mockImplementation(() => new Promise(() => {}));
        const firstRenderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(() => true),
            writeBytes: vi.fn(() => true),
            clear: vi.fn(),
        };
        const fallbackRenderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(() => true),
            writeBytes: vi.fn(() => true),
            clear: vi.fn(),
        };
        const terminalRef = {
            current: firstRenderer as EmbeddedTerminalRendererHandle | null,
        };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey,
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        expect(firstRenderer.write).toHaveBeenCalledWith('cached output', { intent: 'replay' });

        terminalRef.current = fallbackRenderer;
        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });

        expect(fallbackRenderer.clear).toHaveBeenCalledTimes(1);
        expect(fallbackRenderer.write).toHaveBeenCalledWith('cached output', { intent: 'replay' });
        await hook.unmount();
    });

    it('routes user input through the stream carrier after connection', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-input', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true,
            terminalId: 'term-input',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        terminalOps.streamSendInput.mockResolvedValue({ ok: true });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-input:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        hook.getCurrent().onInput('ls\r');
        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(terminalOps.streamSendInput).toHaveBeenCalledWith(
            'machine-1',
            {
                terminalId: 'term-input',
                event: { t: 'text', text: 'ls\r' },
            },
            expect.any(Object),
        );
        expect(terminalOps.input).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('stops routing user input after the stream read loop fails', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-input-error', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_rpc_target_unavailable',
            message: 'terminal RPC target unavailable',
        });
        terminalOps.streamSendInput.mockResolvedValue({ ok: true });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-input-error:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(hook.getCurrent().status).toBe('error');

        hook.getCurrent().onInput('echo hidden\r');
        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(terminalOps.streamSendInput).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('tells a stream that dropped after connecting from a terminal that never started', async () => {
        const renderer: EmbeddedTerminalRendererHandle = { write: vi.fn(), writeBytes: vi.fn(), clear: vi.fn() };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const runUntilError = async (terminalKey: string) => {
            const hook = await renderHook(
                () => useMachineTerminalSession({ machineId: 'machine-1', cwd: '/repo', terminalKey, terminalRef }),
                { flushOptions: { cycles: 1, turns: 1 } },
            );
            await act(async () => {
                hook.getCurrent().onReady(80, 24);
            });
            await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
            return hook;
        };

        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-dropped', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_rpc_target_unavailable',
            message: 'terminal RPC target unavailable',
        });
        const dropped = await runUntilError('session:s-dropped:terminal');
        expect(dropped.getCurrent().status).toBe('error');
        expect(dropped.getCurrent().connectionLost).toBe(true);
        await dropped.unmount();

        terminalOps.ensure.mockResolvedValue({ ok: false, errorCode: 'terminal_spawn_failed', error: 'spawn failed' });
        const neverStarted = await runUntilError('session:s-never-started:terminal');
        expect(neverStarted.getCurrent().status).toBe('error');
        expect(neverStarted.getCurrent().connectionLost).toBe(false);
        await neverStarted.unmount();
    });

    it.each([RPC_ERROR_CODES.OUTCOME_UNKNOWN, 'MACHINE_RPC_TIMEOUT'])('does not repeat terminal creation after an ambiguous %s admission failure', async (errorCode) => {
        terminalOps.ensure.mockRejectedValue(createRpcCallError({ error: 'The terminal creation result was not observed', errorCode }));
        const renderer: EmbeddedTerminalRendererHandle = { write: vi.fn(), clear: vi.fn() };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine-1', cwd: '/repo', terminalKey: `session:no-repeat:${errorCode}`, terminalRef,
        }), { flushOptions: { cycles: 1, turns: 1 } });
        await act(async () => { hook.getCurrent().onReady(80, 24); });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(hook.getCurrent().status).toBe('error');
        expect(hook.getCurrent().error).toBe(errorCode);
        expect(terminalOps.ensure).toHaveBeenCalledTimes(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(resolveTerminalAutoRetryDelayMs(1)); });
        expect(terminalOps.ensure).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('recovers from stale terminal ids reported by stream input', async () => {
        terminalOps.ensure
            .mockResolvedValueOnce({ ok: true, terminalId: 'term-input-stale', reused: false })
            .mockResolvedValueOnce({ ok: true, terminalId: 'term-input-fresh', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true,
            terminalId: 'term-input-stale',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        terminalOps.streamSendInput
            .mockResolvedValueOnce({
                ok: false,
                code: 'terminal_not_found',
                message: 'terminal_not_found',
            })
            .mockResolvedValue({ ok: true });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-input-recovery:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        hook.getCurrent().onInput('echo stale\r');
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        await flushHookEffects({ cycles: 3, turns: 2, runOnlyPendingTimers: true });

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'connected',
            error: null,
        }));
        expect(terminalOps.ensure).toHaveBeenCalledTimes(2);
        expect(terminalOps.streamSendInput).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamSendInput).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            {
                terminalId: 'term-input-stale',
                event: { t: 'text', text: 'echo stale\r' },
            },
            expect.any(Object),
        );

        hook.getCurrent().onInput('echo fresh\r');
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamSendInput).toHaveBeenLastCalledWith(
            'machine-1',
            {
                terminalId: 'term-input-fresh',
                event: { t: 'text', text: 'echo fresh\r' },
            },
            expect.any(Object),
        );

        await hook.unmount();
    });

    it('recovers from stale terminal ids reported by scoped stream input RPC rejections', async () => {
        terminalOps.ensure
            .mockResolvedValueOnce({ ok: true, terminalId: 'term-rpc-stale', reused: false })
            .mockResolvedValueOnce({ ok: true, terminalId: 'term-rpc-fresh', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true,
            terminalId: 'term-rpc-stale',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        terminalOps.streamSendInput
            .mockRejectedValueOnce(createRpcCallError({ error: 'terminal_not_found', errorCode: 'terminal_not_found' }))
            .mockResolvedValue({ ok: true });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-input-rpc-recovery:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        hook.getCurrent().onInput('echo stale rpc\r');
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });
        await flushHookEffects({ cycles: 3, turns: 2, runOnlyPendingTimers: true });

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'connected',
            error: null,
        }));
        expect(terminalOps.ensure).toHaveBeenCalledTimes(2);

        hook.getCurrent().onInput('echo fresh rpc\r');
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamSendInput).toHaveBeenLastCalledWith(
            'machine-1',
            {
                terminalId: 'term-rpc-fresh',
                event: { t: 'text', text: 'echo fresh rpc\r' },
            },
            expect.any(Object),
        );

        await hook.unmount();
    });

    it('keeps the live terminal connected after unsupported resizes and accepts subsequent input', async () => {
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-fixed-size', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true,
            terminalId: 'term-fixed-size',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        terminalOps.streamSendInput
            .mockResolvedValueOnce({ ok: false, code: 'terminal_resize_unavailable', message: 'Resize unavailable' })
            .mockResolvedValue({ ok: true });

        const renderer: EmbeddedTerminalRendererHandle = { write: vi.fn(), writeBytes: vi.fn(), clear: vi.fn() };
        const terminalRef = { current: renderer };
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine-1', cwd: '/repo', terminalKey: 'session:fixed-size:terminal', terminalRef,
        }), { flushOptions: { cycles: 1, turns: 1 } });
        await act(async () => { hook.getCurrent().onReady(80, 24); });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        await act(async () => { hook.getCurrent().onResize(120, 40); });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });
        expect(hook.getCurrent()).toMatchObject({ status: 'connected', error: null });

        hook.getCurrent().onInput('echo still connected\r');
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });
        expect(terminalOps.streamSendInput).toHaveBeenLastCalledWith('machine-1', {
            terminalId: 'term-fixed-size', event: { t: 'text', text: 'echo still connected\r' },
        }, expect.any(Object));
        expect(hook.getCurrent()).toMatchObject({ status: 'connected', error: null });
        await hook.unmount();
    });

    it.each(['text', 'resize'] as const)('reports non-recoverable %s failures instead of silently staying connected', async (event) => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-input-failure', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true,
            terminalId: 'term-input-failure',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        terminalOps.streamSendInput.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_rpc_target_unavailable',
            message: 'terminal RPC target unavailable',
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-input-failure:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        await act(async () => {
            if (event === 'resize') hook.getCurrent().onResize(120, 40);
            else hook.getCurrent().onInput('echo hidden\r');
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'error',
            error: 'terminal RPC target unavailable',
        }));

        await hook.unmount();
    });

    it('uses legacy event-cursor reads when terminal.transport.byteStream is disabled', async () => {
        byteStreamEnabled = false;
        await refreshTerminalFeatures();
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-legacy-feature', reused: false });
        terminalOps.streamRead.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-legacy-feature',
            events: [{ t: 'data', data: 'legacy output' }],
            nextCursor: 1,
            done: true,
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-legacy-feature:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).not.toHaveBeenCalled();
        expect(terminalOps.streamRead).toHaveBeenCalledWith(
            'machine-1',
            {
                terminalId: 'term-legacy-feature',
                cursor: 0,
                maxBytes: undefined,
                maxEvents: undefined,
            },
            expect.any(Object),
        );
        expect(renderer.writeBytes).toHaveBeenCalledWith(expect.objectContaining({
            terminalId: 'term-legacy-feature',
            byteOffset: 0,
            bytes: new TextEncoder().encode('legacy output'),
        }));

        await hook.unmount();
    });
});
