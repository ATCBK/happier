import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { accountSettingsParse } from '@happier-dev/protocol';

import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { createNativeAgentCurrentSessionUiServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { createPluginInteractionsService } from '@/plugins/runtime/invocation/services/interactions';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { ServerBoundPermissionRpcHandlerManager } from '@/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, commitActivePromptLibraryCatalog, getActiveAccountSettingsSnapshotLifetimeToken,
    setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

beforeEach(() => {
    const scopeKey = resolveAccountSettingsScopeKey({ token: 'realtime-permission-account', encryption: null });
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}),
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    commitActivePromptLibraryCatalog({ scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
        catalog: { status: 'ready', rows: [{ revision: 1,
            record: { key: 'role-overrides', value: { v: 1, overrides: {} } } }], tombstones: [], diagnostics: [] } });
});
afterEach(() => {
    clearActiveAccountSettingsSnapshot();
    vi.restoreAllMocks();
});

type AppServerRequestHandler = (
    params: unknown,
    message: Readonly<{ id?: unknown }>,
) => unknown | Promise<unknown>;

type AppServerBoundaryClient = Readonly<{
    launchFeatures: Readonly<{
        realtimeConversationAdvertised: boolean;
    }>;
    request(method: string, params?: unknown, options?: Readonly<{ timeoutMs?: number | null; signal?: AbortSignal }>): Promise<unknown>;
    notify(method: string, params?: unknown): Promise<void>;
    registerRequestHandler(method: string, handler: AppServerRequestHandler): () => void;
    registerNotificationHandler(
        method: string,
        handler: (params: unknown) => void | Promise<void>,
    ): () => void;
    onExit(listener: (result: Readonly<{
        exitCode: number | null;
        signal: string | null;
    }>) => void): () => void;
    dispose(): Promise<void>;
}>;

type RealtimeStartResult =
    | Readonly<{
        status: 'started';
        transport: Readonly<{
            kind: 'webrtc';
            answerSdp: string;
        }>;
        handle: Readonly<{
            stop(): Promise<unknown>;
            watch(listener: (event: unknown) => void): Readonly<{ dispose(): void }>;
        }>;
    }>
    | Readonly<{ status: 'busy' | 'aborted' | 'unavailable' | 'failed' }>;

type CodexAppServerOwners = Readonly<{
    registerInteractionHandlers(params: Readonly<{
        client: AppServerBoundaryClient;
        ui: ReturnType<typeof createPluginInteractionsService>;
        getThreadId(): string | null;
    }>): void;
    createRealtimeConversation(params: Readonly<{
        getClient(): Promise<AppServerBoundaryClient>;
        getThreadId(): string | null;
        isDisposed(): boolean;
    }>): Readonly<{
        inspect(): Promise<
            | Readonly<{ status: 'available'; transport: 'webrtc' }>
            | Readonly<{ status: 'unavailable'; reason: string; diagnostic: unknown }>
        >;
        start(input: Readonly<{
            transport: Readonly<{ kind: 'webrtc'; offerSdp: string }>;
        }>): Promise<RealtimeStartResult>;
    }>;
}>;

async function loadCodexAppServerOwners(): Promise<CodexAppServerOwners> {
    const interactionsModulePath =
        '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/interactions.js';
    const realtimeModulePath =
        '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/realtime.js';
    const [interactions, realtime] = await Promise.all([
        import(interactionsModulePath),
        import(realtimeModulePath),
    ]);
    return {
        registerInteractionHandlers: interactions.registerCodexAppServerInteractionHandlers,
        createRealtimeConversation: realtime.createCodexAppServerRealtimeConversation,
    } as CodexAppServerOwners;
}

function createAppServerBoundary(options?: Readonly<{
    applyAuthorizedCommandEffect?: (params: Readonly<{
        command: string;
        decision: 'accept' | 'acceptForSession';
    }>) => void | Promise<void>;
}>) {
    const requestHandlers = new Map<string, AppServerRequestHandler>();
    const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
    const request = vi.fn(async (method: string) => {
        if (method === 'experimentalFeature/list') {
            return {
                data: [{ name: 'realtime_conversation', enabled: true }],
                nextCursor: null,
            };
        }
        return {};
    });
    const notify = vi.fn(async () => {});
    const client: AppServerBoundaryClient = {
        launchFeatures: {
            realtimeConversationAdvertised: true,
        },
        request,
        notify,
        registerRequestHandler(method, handler) {
            requestHandlers.set(method, handler);
            return () => requestHandlers.delete(method);
        },
        registerNotificationHandler(method, handler) {
            const handlers = notificationHandlers.get(method) ?? new Set();
            handlers.add(handler);
            notificationHandlers.set(method, handlers);
            return () => handlers.delete(handler);
        },
        onExit: () => () => {},
        dispose: vi.fn(async () => {}),
    };

    return {
        client,
        request,
        notify,
        async invoke(method: string, params: unknown, id: string): Promise<unknown> {
            const handler = requestHandlers.get(method);
            if (!handler) throw new Error(`Missing app-server request handler: ${method}`);
            const response = await handler(params, { id });
            const decision = response && typeof response === 'object' && !Array.isArray(response)
                ? (response as Readonly<Record<string, unknown>>).decision
                : null;
            const command = params && typeof params === 'object' && !Array.isArray(params)
                ? (params as Readonly<Record<string, unknown>>).command
                : null;
            if (
                method === 'item/commandExecution/requestApproval'
                && typeof command === 'string'
                && (decision === 'accept' || decision === 'acceptForSession')
            ) {
                await options?.applyAuthorizedCommandEffect?.({ command, decision });
            }
            return response;
        },
        publish(method: string, params: unknown): void {
            for (const handler of notificationHandlers.get(method) ?? []) {
                handler(params);
            }
        },
    };
}

describe('Codex app-server permission-card data composition', () => {
    it('projects a native command approval into canonical Bash card data', async () => {
        const codex = await loadCodexAppServerOwners();
        const session = createMutableApiSessionClientFixture<Record<string, unknown>>({
            sessionId: 'codex-command-card-session',
            metadata: {},
            agentState: { requests: {}, completedRequests: {} },
        });
        const permissionHandler = createProviderEnforcedPermissionHandler({
            session,
            logPrefix: '[Codex command card composition test]',
            onAbortRequested: async () => {},
        });
        const sessionLifetime = new AbortController();
        onTestFinished(async () => {
            sessionLifetime.abort();
            await permissionHandler.reset();
            await session.close();
        });
        const ui = createPluginInteractionsService({
            currentSession: createNativeAgentCurrentSessionUiServices({
                permissionHandler,
                pluginId: 'happier.agent.codex',
                contributionId: 'codex',
                runtimeId: 'codex',
                sessionId: session.sessionId,
                occurrenceId: 'codex-command-card-occurrence',
                interactionDeadlineMs: 1_000,
                isCurrent: () => true,
                signal: sessionLifetime.signal,
            }),
            signal: sessionLifetime.signal,
            isOccurrenceCurrent: () => true,
        });
        const appServer = createAppServerBoundary();
        codex.registerInteractionHandlers({
            client: appServer.client,
            ui,
            getThreadId: () => 'thread-1',
        });

        const vendorResponse = appServer.invoke(
            'item/commandExecution/requestApproval',
            {
                threadId: 'thread-1',
                turnId: 'turn-1',
                itemId: 'command-1',
                startedAtMs: 1,
                environmentId: null,
                reason: 'The delegated turn needs permission.',
                command: 'git fetch origin',
                cwd: '/workspace',
                availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
            },
            'vendor-command-card-request',
        );

        let permissionRequestId = '';
        await vi.waitFor(() => {
            const pending = Object.entries(session.__getAgentState().requests ?? {}).find(([, request]) => request.tool === 'Bash');
            expect(pending?.[1]).toMatchObject({
                tool: 'Bash',
                arguments: {
                    command: 'git fetch origin',
                    cwd: '/workspace',
                    reason: 'The delegated turn needs permission.',
                },
                kind: 'permission',
                owner: {
                    kind: 'plugin',
                    pluginId: 'happier.agent.codex',
                    runtimeId: 'codex',
                },
            });
            permissionRequestId = pending![0];
        });
        expect(
            session.__getAgentState().requests?.[permissionRequestId]?.arguments,
        ).not.toHaveProperty('threadId');

        appServer.publish('serverRequest/resolved', {
            threadId: 'thread-1',
            requestId: 'vendor-command-card-request',
        });
        await expect(vendorResponse).resolves.toEqual({ decision: 'cancel' });
        sessionLifetime.abort();
    });
});

const permissionCases = [
    {
        label: 'approve once',
        response: { approved: true, decision: 'approved' as const },
        appServerDecision: 'accept',
        completedDecision: 'approved',
    },
    {
        label: 'approve for session',
        response: { approved: true, decision: 'approved_for_session' as const },
        appServerDecision: 'acceptForSession',
        completedDecision: 'approved_for_session',
    },
    {
        label: 'deny',
        response: { approved: false, decision: 'denied' as const },
        appServerDecision: 'decline',
        completedDecision: 'denied',
    },
    {
        label: 'cancel',
        response: { approved: false, decision: 'abort' as const },
        appServerDecision: 'cancel',
        completedDecision: 'abort',
    },
] as const;

describe('Codex global Voice permission custody composition', () => {
    it.each(permissionCases)(
        'settles the hidden-session command effect one-or-zero times after End Voice: $label',
        async ({ response, appServerDecision, completedDecision }) => {
            const codex = await loadCodexAppServerOwners();
            const session = createMutableApiSessionClientFixture<Record<string, unknown>>({
                sessionId: 'global-voice-session',
                metadata: {
                    systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
                    voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
                },
                agentState: { requests: {}, completedRequests: {} },
            });
            const serverRpc = new ServerBoundPermissionRpcHandlerManager(session.sessionId);
            // Permission actors are stamped by authenticated Home ingress.
            vi.spyOn(session.rpcHandlerManager, 'registerHandler').mockImplementation((name, handler) => serverRpc.registerHandler(name, handler));
            const respondPermission = async (payload: unknown) => {
                const handler = serverRpc.handlers.get(RPC_METHODS.SESSION_PERMISSION_RESPOND);
                if (!handler) throw new Error('Permission response handler unavailable');
                return await handler(payload);
            };
            let abortCodingTurnCalls = 0;
            const permissionHandler = createProviderEnforcedPermissionHandler({
                session,
                logPrefix: '[Codex global Voice custody test]',
                onAbortRequested: async () => {
                    abortCodingTurnCalls += 1;
                },
            });
            const sessionLifetime = new AbortController();
            onTestFinished(async () => {
                sessionLifetime.abort();
                await permissionHandler.reset();
                await session.close();
            });
            const currentSessionUi = createNativeAgentCurrentSessionUiServices({
                permissionHandler,
                pluginId: 'happier.agent.codex',
                contributionId: 'codex',
                runtimeId: 'codex',
                sessionId: session.sessionId,
                occurrenceId: 'codex-occurrence-1',
                interactionDeadlineMs: 1_000,
                isCurrent: () => true,
                signal: sessionLifetime.signal,
            });
            const ui = createPluginInteractionsService({
                currentSession: currentSessionUi,
                signal: sessionLifetime.signal,
                isOccurrenceCurrent: () => true,
            });
            const authorizedCommandEffects: Array<{
                command: string;
                decision: 'accept' | 'acceptForSession';
            }> = [];
            const appServer = createAppServerBoundary({
                applyAuthorizedCommandEffect: (effect) => {
                    authorizedCommandEffects.push(effect);
                },
            });
            codex.registerInteractionHandlers({
                client: appServer.client,
                ui,
                getThreadId: () => 'thread-1',
            });
            const conversation = codex.createRealtimeConversation({
                getClient: async () => appServer.client,
                getThreadId: () => 'thread-1',
                isDisposed: () => false,
            });
            await expect(conversation.inspect()).resolves.toEqual({
                status: 'available',
                transport: 'webrtc',
            });

            const starting = conversation.start({
                transport: { kind: 'webrtc', offerSdp: 'offer' },
            });
            await vi.waitFor(() => expect(appServer.request).toHaveBeenCalledWith(
                'thread/realtime/start',
                expect.objectContaining({
                    threadId: 'thread-1',
                    flushTranscriptTailOnSessionEnd: false,
                }),
                expect.objectContaining({ timeoutMs: null }),
            ));
            appServer.publish('thread/realtime/started', {
                threadId: 'thread-1',
                realtimeSessionId: null,
                version: 'v3',
            });
            appServer.publish('thread/realtime/sdp', {
                threadId: 'thread-1',
                sdp: 'answer',
            });
            const started = await starting;
            expect(started).toMatchObject({
                status: 'started',
                transport: {
                    kind: 'webrtc',
                    answerSdp: 'answer',
                },
            });
            if (started.status !== 'started') throw new Error('Expected Codex realtime to start');
            const realtimeTerminalEvents: unknown[] = [];
            const terminalWatch = started.handle.watch((event) => {
                realtimeTerminalEvents.push(event);
            });

            let vendorResponseSettlements = 0;
            const vendorResponse = appServer.invoke(
                'item/commandExecution/requestApproval',
                {
                    threadId: 'thread-1',
                    turnId: 'turn-1',
                    itemId: 'command-1',
                    startedAtMs: 1,
                    environmentId: null,
                    reason: 'The delegated turn needs permission.',
                    command: 'git fetch origin',
                    cwd: '/workspace',
                    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
                },
                'vendor-permission-1',
            );
            void vendorResponse.then(
                () => {
                    vendorResponseSettlements += 1;
                },
                () => {
                    vendorResponseSettlements += 1;
                },
            );

            let permissionRequestId = '';
            await vi.waitFor(() => {
                const pending = Object.entries(session.__getAgentState().requests ?? {})
                    .find(([, request]) => request.tool === 'Bash');
                expect(pending?.[1]).toMatchObject({
                    tool: 'Bash',
                    arguments: {
                        command: 'git fetch origin',
                        cwd: '/workspace',
                        reason: 'The delegated turn needs permission.',
                    },
                    kind: 'permission',
                    owner: {
                        kind: 'plugin',
                        pluginId: 'happier.agent.codex',
                        runtimeId: 'codex',
                    },
                });
                permissionRequestId = pending![0];
            });
            expect(
                session.__getAgentState().requests?.[permissionRequestId]?.arguments,
            ).not.toHaveProperty('threadId');
            expect(vendorResponseSettlements).toBe(0);

            await expect(started.handle.stop()).resolves.toEqual({ status: 'stopped' });
            await Promise.resolve();
            expect(realtimeTerminalEvents).toEqual([{ kind: 'terminal', reason: 'stopped' }]);
            expect(sessionLifetime.signal.aborted).toBe(false);
            expect(vendorResponseSettlements).toBe(0);
            expect(session.__getAgentState().requests?.[permissionRequestId]).toBeDefined();
            expect(abortCodingTurnCalls).toBe(0);

            const wirePermissionResponse = JSON.parse(JSON.stringify({
                id: permissionRequestId,
                ...response,
            })) as {
                id: string;
                approved: boolean;
                decision: typeof response.decision;
            };
            expect(wirePermissionResponse).toEqual({
                id: permissionRequestId,
                ...response,
            });
            const staleApproval = JSON.parse(JSON.stringify({
                id: permissionRequestId,
                approved: true,
                decision: 'approved',
            })) as {
                id: string;
                approved: boolean;
                decision: 'approved';
            };
            const [firstResponse, repeatedOrStaleResponse] = await Promise.all([
                respondPermission(wirePermissionResponse),
                respondPermission(staleApproval),
            ]);
            expect(firstResponse).toBeUndefined();
            if (response.decision === 'approved') {
                // An identical in-flight answer rejoins the first claim; the
                // native effect and settlement below must still happen once.
                expect(repeatedOrStaleResponse).toBeUndefined();
            } else {
                expect(repeatedOrStaleResponse).toEqual({
                    ok: false,
                    errorCode: 'permission_request_not_found',
                    requestId: permissionRequestId,
                });
            }
            await expect(vendorResponse).resolves.toEqual({ decision: appServerDecision });
            expect(vendorResponseSettlements).toBe(1);
            expect(authorizedCommandEffects).toEqual(
                response.approved
                    ? [{ command: 'git fetch origin', decision: appServerDecision }]
                    : [],
            );
            expect(session.__getAgentState().requests?.[permissionRequestId]).toBeUndefined();
            expect(session.__getAgentState().completedRequests?.[permissionRequestId]).toMatchObject({
                decision: completedDecision,
            });
            expect(abortCodingTurnCalls).toBe(
                response.decision === 'abort' ? 1 : 0,
            );

            // The persisted completed claim also rejoins an identical present-user
            // retry, while a different decision cannot authorize another effect.
            await expect(respondPermission(JSON.parse(JSON.stringify(wirePermissionResponse)))).resolves.toBeUndefined();
            const conflictingResponse = {
                id: permissionRequestId,
                approved: response.decision !== 'approved',
                decision: response.decision === 'approved' ? 'denied' : 'approved',
            };
            await expect(respondPermission(conflictingResponse)).resolves.toEqual({
                ok: false,
                errorCode: 'permission_request_not_found',
                requestId: permissionRequestId,
            });
            expect(vendorResponseSettlements).toBe(1);
            expect(authorizedCommandEffects).toEqual(
                response.approved
                    ? [{ command: 'git fetch origin', decision: appServerDecision }]
                    : [],
            );
            expect(appServer.request.mock.calls.filter(
                ([method]) => method === 'thread/realtime/start',
            )).toHaveLength(1);
            expect(appServer.request.mock.calls.filter(
                ([method]) => method === 'thread/realtime/stop',
            )).toHaveLength(1);
            expect(appServer.notify).not.toHaveBeenCalled();
            expect(realtimeTerminalEvents).toEqual([{ kind: 'terminal', reason: 'stopped' }]);
            expect(session.__getMetadata()).toEqual({
                systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
                voiceConversationScopeV1: { v: 1, kind: 'voice_home' },
            });
            terminalWatch.dispose();
        },
    );
});
