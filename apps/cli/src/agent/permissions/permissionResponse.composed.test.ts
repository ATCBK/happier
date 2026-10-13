import '../../../../ui/sources/dev/vitestSetup';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import { io as socketBoundary } from 'socket.io-client';
import * as React from 'react';
import { AgentStateSchema } from '@happier-dev/session-core/state';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { listPendingPermissionRequests } from '@happier-dev/session-core/pending';
import { SessionPermissionRespondRpcParamsV1Schema } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { accountSettingsParse, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, buildAccountStoredContentCompatibilitySocketAuthV1 } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { AgentState } from '@/api/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';
import { ProviderEnforcedPermissionHandler } from './providerEnforced/handler';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { registerSocketRpcHandlers } from '../../../../server/sources/app/api/socket/rpc/registerSocketRpcHandlers';
import { evaluateAccountStoredContentSocketCompatibility } from '../../../../server/sources/app/clientCompatibility/accountStoredContentCompatibility';
import { createSessionMachineAccessKeyInTx } from '../../../../server/sources/app/accessKeys/sessionMachineAccessKeyMutations';
import { resolveSessionScopedSocketBinding } from '../../../../server/sources/app/api/socket/sessionScopedBinding';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource, pressTestInstanceAsync, standardCleanup } from '../../../../ui/sources/dev/testkit';
import { installPermissionShellCommonModuleMocks } from '../../../../ui/sources/components/tools/shell/permissions/permissionShellTestHelpers';
import { createNativeAgentCurrentSessionUiServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { createPluginInteractionsService } from '@/plugins/runtime/invocation/services/interactions';
import { createClaudeNativePermissionEngine } from '../../../../../packages/plugins/claude/src/agent/permissions/nativePermissionEngine';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionFixture } from '../../../../ui/sources/dev/testkit/harness/sessionActionRpcBoundary';
import { loadSyncSingletonForTests } from '../../../../ui/sources/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '../../../../ui/sources/dev/testkit/fixtures/accountEncryptionCurrentness';

vi.mock('socket.io-client', async importOriginal =>
    (await import('../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// Keep actual sockets for the relay; the app's SDK boundary forwards its real
// emitted carrier to those sockets without rebuilding its Action or RPC payload.
void socketBoundary;
const { io } = await vi.importActual<typeof import('socket.io-client')>('socket.io-client');
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();

// Only platform boundaries use the canonical UI mocks; keep the real store.
installPermissionShellCommonModuleMocks({ storage: async importOriginal => await importOriginal() });
await loadSyncSingletonForTests();
const { PermissionFooter } = await import('../../../../ui/sources/components/tools/shell/permissions/PermissionFooter');
const { PermissionPromptCard } = await import('../../../../ui/sources/components/tools/shell/permissions/PermissionPromptCard');
const { createAppSessionTranscriptActions } = await import('../../../../ui/sources/components/sessions/transcript/source/appSessionTranscriptActions');
const { storage } = await import('../../../../ui/sources/sync/domains/state/storage');
const { Platform } = await import('react-native');
const { createBoundPluginSurfaceController } = await import('../../../../ui/sources/components/plugins/surfaces/boundPluginSurfaceController');
const { createCanonicalPluginReactNativeHostApiAdapter } = await import('../../../../ui/sources/components/plugins/reactNative/hostApi');
const { createPluginSurfaceContextFixture } = await import('../../../../ui/sources/dev/testkit/fixtures/pluginSurfaceContextFixture');
const { captureActiveServerAccountScopeLifetime } = await import('../../../../ui/sources/sync/domains/scope/activeServerAccountScope');

describe('Session permission responses through production UI Actions and the authenticated relay', () => {
    let database: LightSqliteHarness;
    // Canonical migration preparation is outside the interactive response
    // cases. Let its actual completion/error settle instead of imposing a
    // shorter phase cutoff on the containing composed validation command.
    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-permission-response-', initAuth: false });
    }, 0);
    afterAll(async () => { if (database) await database.close(); });
    beforeEach(async () => {
        await homes.reset();
        installHomeGovernanceBoundaries(homes);
        setActiveAccountSettingsSnapshot({ scopeKey: 'edit-seam', source: 'network', settingsVersion: 1,
        settings: accountSettingsParse({}), rawSettings: {}, settingsSecretsReadKeys: [], loadedAtMs: 1,
        promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    });
    afterEach(() => resetActiveAccountSettingsSnapshotForTests());
    afterEach(standardCleanup);

    it.each(['allowOnce', 'acceptEdits', 'nativeAllowOnce', 'nativeBashPlugin', 'misboundAction'] as const)('delivers %s through the production Action and relay', async button => {
        const isNative = button === 'nativeAllowOnce' || button === 'nativeBashPlugin';
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const row = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
        await expect(createSessionMachineAccessKeyInTx(db, {
            accountId: account.id, sessionId: row.id, machineId: machine.id, data: 'fixture-access-key',
        })).resolves.toMatchObject({ ok: true });
        const binding = await resolveSessionScopedSocketBinding({ userId: account.id, sessionId: row.id, machineId: machine.id });
        if (!binding.ok) throw new Error('Missing admitted Session publisher binding');
        const manager = new RpcHandlerManager({ scopePrefix: row.id, encryptionMode: 'plain', logger: () => {} });
        let state: AgentState = { requests: {}, completedRequests: {} };
        // Session persistence is the boundary fixture; the request coordinator,
        // projection, UI codecs, Socket.IO relay and permission handler are real.
        const session = {
            sessionId: row.id,
            rpcHandlerManager: manager,
            getAgentStateSnapshot: () => state,
            getMetadataSnapshot: () => null,
            updateAgentState: async (update: (previous: AgentState) => AgentState) => {
                const next = update(state);
                await db.session.update({ where: { id: row.id }, data: { agentState: JSON.stringify(next) } });
                state = next;
            },
        };
        const handler = new ProviderEnforcedPermissionHandler(session as unknown as ApiSessionClient, { logPrefix: '[Permission seam]' });
        let requestId: string = randomUUID();
        const turnId = `native-turn-${randomUUID()}-1`;
        const toolName = button === 'nativeBashPlugin' ? 'Bash' : 'Edit';
        const input = toolName === 'Bash' ? { command: 'pwd' }
            : { file_path: '/fixture/alpha.txt', old_string: 'before', new_string: 'after' };
        const permissionContext = { turnId,
            causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const } };
        const nativeUi = createNativeAgentCurrentSessionUiServices({ permissionHandler: handler,
            pluginId: 'happier.agent.claude', contributionId: 'claude', runtimeId: 'claude/runtime', sessionId: row.id,
            occurrenceId: randomUUID(), isCurrent: () => true, signal: new AbortController().signal });
        const interactions = createPluginInteractionsService({ currentSession: nativeUi,
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            readActiveTurnAdmissionWitness: () => ({ inputId: randomUUID(), userMessageSeq: null,
                userMessageSeqs: [], ...permissionContext }) });
        // The runtime context is a boundary fixture; its exercised interaction
        // service, native Claude producer and host presentation owner are real.
        const nativeContext = { services: { interactions } } as unknown as AgentRuntimeContext;
        const pending = isNative
            ? createClaudeNativePermissionEngine(nativeContext).canCallTool(toolName, input)
            : handler.handleToolCall(requestId, toolName, input, permissionContext);
        void pending.catch(() => {});
        const http = createServer();
        const sockets = new Server(http);
        const compatibility = evaluateAccountStoredContentSocketCompatibility(
            buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
        ).evaluation;
        sockets.on('connection', socket => {
            socket.data = {
                clientType: socket.handshake.query.publisher === '1' ? 'session-scoped' : 'user-scoped',
                sessionId: row.id,
                ...(socket.handshake.query.publisher === '1' ? { sessionScopedBinding: binding.binding } : {}),
                authAuthority: 'present_user',
                authTokenAuthenticationEvidence: [],
                accountStoredContentCompatibility: compatibility,
            };
            registerSocketRpcHandlers({ userId: account.id, socket, io: sockets });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback listener');
        const url = `http://127.0.0.1:${address.port}`;
        const publisher = io(url, { autoConnect: false, reconnection: false, query: { publisher: '1' } });
        const caller = io(url, { autoConnect: false, reconnection: false });
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        publisher.on(SOCKET_RPC_EVENTS.REQUEST, (request: RpcRequest, acknowledge: (result: unknown) => void) => {
            void manager.handleRequest(request).then(acknowledge);
        });
        async function connect(socket: ReturnType<typeof io>) {
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('connect_error', reject);
                socket.connect();
            });
        }
        try {
            if (isNative) {
                await vi.waitFor(() => expect(Object.keys(state.requests ?? {})).toHaveLength(1));
                requestId = Object.keys(state.requests!)[0]!;
                expect(state.requests![requestId]).toMatchObject({ source: 'native_tool_approval_once', turnId });
            }
            await vi.waitFor(() => expect(state.requests?.[requestId]?.turnId).toBe(turnId));
            const persisted = await db.session.findUniqueOrThrow({ where: { id: row.id }, select: { agentState: true } });
            const projection = createReducer();
            const { messages } = reducer(projection, [], AgentStateSchema.parse(JSON.parse(persisted.agentState!)));
            const projectedMessage = messages.find(message => message.kind === 'tool-call');
            const permission = projectedMessage?.kind === 'tool-call' ? projectedMessage.tool.permission : null;
            if (!permission) throw new Error('Pending permission was not projected');
            // The list/summary can omit AgentState while the transcript keeps
            // its permission. Do not invent custody from the Session latest turn.
            expect(permission.turnId).toBe(turnId);
            await connect(publisher);
            manager.onSocketConnect(publisher);
            await expect(manager.waitForRegisteredHandlers(['session.permission.respond'], { timeoutMs: 5_000 })).resolves.toEqual({ status: 'ready' });
            await connect(caller);
            const serverId = await homes.addHome({ name: 'Permission approval Home', serverUrl: url, accountId: account.id });
            homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
            const token = homes.findByServerUrl(url)?.token;
            if (!token) throw new Error('Missing synthetic Home Account credential');
            const rpcReplies: unknown[] = [];
            const emittedMethods: string[] = [];
            const emittedCarriers: ReturnType<typeof SessionPermissionRespondRpcParamsV1Schema.parse>[] = [];
            connection = await restoreServerAccountForTest({ serverUrl: url, credentials: { token }, request: homes.request,
                configureSocket: socket => {
                    vi.mocked(socket.connect).mockImplementation(() => {
                        socket.connected = true;
                        for (const listener of socket.listeners('connect')) listener();
                        return socket;
                    });
                    socket.timeout = () => socket;
                    socket.emitWithAck = async (event, ...args) => {
                        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
                        const wire: unknown = args[0];
                        if (!wire || typeof wire !== 'object' || !('params' in wire) || !('method' in wire)
                            || typeof wire.method !== 'string') throw new Error('Missing production RPC carrier');
                        const carrier = SessionPermissionRespondRpcParamsV1Schema.parse(wire.params);
                        emittedCarriers.push(carrier);
                        emittedMethods.push(wire.method);
                        const response = await caller.timeout(5_000).emitWithAck(event, ...args);
                        rpcReplies.push(response);
                        return response;
                    };
                },
            });
            installHomeGovernanceBoundaries(homes);
            const uiSession = installSessionActionFixture({ homes, storage, serverId, session: { id: row.id,
                agentState: button === 'nativeBashPlugin' ? AgentStateSchema.parse(JSON.parse(persisted.agentState!)) : null,
                encryptionMode: 'plain', metadata: { path: '/fixture', host: 'fixture', machineId: machine.id, flavor: 'claude' } } });
            if (button === 'nativeBashPlugin') {
                storage.getState().applyMessages(row.id, []);
                storage.getState().applySessions([{ ...uiSession, agentState: null }]);
            }
            let actionSessionId = row.id;
            if (button === 'misboundAction') {
                const other = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
                actionSessionId = other.id;
                installSessionActionFixture({ homes, storage, serverId, session: { id: other.id, encryptionMode: 'plain' } });
            }
            const actions = createAppSessionTranscriptActions(actionSessionId, serverId);
            if (button === 'nativeAllowOnce') {
                // Real Action producer -> exact strict native consumer. An
                // unsupported reusable grant must leave the request pending.
                await expect(actions.respondToPermission({ id: requestId, turnId, approved: true, mode: 'acceptEdits',
                    updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
                })).rejects.toMatchObject({ code: 'permission_response_invalid' });
                expect(rpcReplies.at(-1)).toMatchObject({ ok: true, result: { ok: false, errorCode: 'permission_response_invalid' } });
                expect(state.requests?.[requestId]).toMatchObject({ source: 'native_tool_approval_once', turnId });
            }
            const source = createTestSessionTranscriptSource({ sessionId: row.id, serverId, agentState: null,
                interaction: { canApprovePermissions: true, canSendMessages: true },
                actions,
            });
            const pendingRequest = listPendingPermissionRequests({ sessionId: row.id, active: true, agentState: null }, messages)
                .find(request => request.id === requestId);
            if (!pendingRequest) throw new Error('Real projected request was not available to the prompt card');
            const screen = await renderWithSessionTranscriptSource(React.createElement(PermissionPromptCard, {
                sessionId: row.id, request: pendingRequest, location: null, metadata: uiSession.metadata,
                canApprovePermissions: true,
            }), source);
            const renderedFooter = screen.findAll(node => node.type === PermissionFooter)[0];
            if (!renderedFooter) throw new Error('The production prompt did not render its permission footer');
            const grants = renderedFooter.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'button'
                && typeof node.props.onPress === 'function' && node.props.testID === undefined);
            expect(grants).toHaveLength(isNative ? 0 : 1);
            if (button === 'nativeBashPlugin') {
                const lifetime = captureActiveServerAccountScopeLifetime();
                if (!lifetime) throw new Error('Missing restored plugin Account lifetime');
                const controller = createBoundPluginSurfaceController({ facts: {
                    pluginId: 'acme.triage', contributionId: 'desk', surfaceId: 'approval-seam', placement: 'appSurface',
                    platform: 'web', channel: 'internal', accountLifetime: lifetime,
                    interactionEnabled: true, daemonInteractionEnabled: false,
                } });
                const adapter = createCanonicalPluginReactNativeHostApiAdapter({
                    surface: createPluginSurfaceContextFixture({ target: { kind: 'app' } }),
                    requestSurface: controller.surfaceContext, requestIdPrefix: 'native-bash',
                    handleRequest: controller.hostApi.handleRequest, installedMethods: controller.hostApi.installedMethods,
                });
                try {
                    const read = await adapter.api.readSession(row.id);
                    expect(read?.pendingPermissions).toEqual([expect.objectContaining({ requestId, toolName: 'Bash', answers: ['allowOnce', 'deny'] })]);
                    await expect(adapter.api.respondToSessionPermission({ sessionId: row.id, requestId, answer: 'allowForSession' }))
                        .resolves.toEqual({ status: 'refused', reason: 'answerUnavailable' });
                    expect(emittedMethods).toEqual([]);
                    await expect(adapter.api.respondToSessionPermission({ sessionId: row.id, requestId, answer: 'allowOnce' }))
                        .resolves.toEqual({ status: 'answered' });
                } finally { adapter.dispose(); controller.dispose(); }
            } else if (button === 'acceptEdits') {
                await pressTestInstanceAsync(grants[0]!, 'all edits');
            } else {
                await screen.pressByTestIdAsync('permission-footer.allow');
            }
            if (button === 'misboundAction') {
                // The same footer and real executor are deliberately bound to
                // another admitted Session, which has no responding publisher.
                expect(emittedMethods).toEqual([`${actionSessionId}:session.permission.respond`]);
                expect(rpcReplies.at(-1)).toMatchObject({ ok: false });
                expect(screen.findHostByTestId('permission-footer.action-error')).not.toBeNull();
                expect(state.requests?.[requestId]).toMatchObject({ turnId });
                expect(state.completedRequests?.[requestId]).toBeUndefined();
                return;
            }
            expect(emittedMethods.at(-1)).toBe(`${row.id}:session.permission.respond`);
            expect(['ios', 'android', 'web']).toContain(Platform.OS);
            expect(emittedCarriers.at(-1)).toMatchObject({ id: requestId, turnId, answeringClientCategory: Platform.OS });
            if (button === 'acceptEdits') expect(emittedCarriers.at(-1)?.mode).toBe('acceptEdits');
            expect(rpcReplies.at(-1)).toMatchObject({ ok: true, result: null });
            expect(screen.findHostByTestId('permission-footer.action-error')).toBeNull();
            await expect(pending).resolves.toMatchObject(isNative
                ? { behavior: 'allow', updatedInput: input } : { decision: 'approved' });
            const completed = await db.session.findUniqueOrThrow({ where: { id: row.id }, select: { agentState: true } });
            expect(JSON.parse(completed.agentState!).completedRequests[requestId]).toMatchObject({
                status: 'approved', turnId, answeringClientCategory: Platform.OS,
                permissionDecisionActorV1: { kind: 'accountUser', accountId: account.id },
                ...(button === 'acceptEdits' ? {
                    updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
                } : {}),
            });
        } finally {
            await connection?.dispose();
            await handler.reset();
            manager.onSocketDisconnect();
            publisher.disconnect();
            caller.disconnect();
            await new Promise<void>(resolve => sockets.close(() => resolve()));
        }
    });
});
