import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, getActionSpec, type ApprovalRequest,
    ApprovalRequestSchema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';
import { DaemonTerminalEnsureResponseSchema } from '@happier-dev/protocol/daemon/terminal';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { isApprovalExecutionOriginCurrentForAccountContext } from '@/sync/ops/actions/defaultActionExecutor';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { inspectMachineTerminalMemberApproval } from './machineTerminalApproval';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { resolveSessionTerminalIdentity } from './sessionTerminalMode';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { db } from '../../../../../server/sources/storage/db';
import { artifactsRoutes } from '../../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { createCliActionDeps } from '../../../../../cli/src/session/actions/createCliActionDeps';
import { RpcHandlerManager } from '../../../../../cli/src/api/rpc/RpcHandlerManager';
import { registerMachineTerminalRpcHandlers } from '../../../../../cli/src/api/machine/rpcHandlers.terminal';
import { createTerminalPtySessionManager } from '../../../../../cli/src/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '../../../../../cli/src/terminal/pty/config';
import type { PtyExitEvent, PtyProcess, PtyProvider } from '../../../../../cli/src/terminal/pty/provider';
import * as ptyOsBoundary from '../../../../../cli/src/terminal/pty/provider';
import * as processTreeOsBoundary from '../../../../../cli/src/processes/terminate/terminateProcessTree';
import * as processGroupOsBoundary from '@happier-dev/cli-common/process';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { Fastify as AppFastify } from '../../../../../server/sources/app/api/types';
import { decodeBase64, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { ApiClient } from '../../../../../cli/src/api/api';
import { writeCredentialsTokenOnlyForServerId } from '../../../../../cli/src/persistence';
import type { ApiMachineClient } from '../../../../../cli/src/api/apiMachine';
import { runWithServerHttpBaseUrl } from '../../../../../cli/src/api/client/serverHttpBaseUrl';
import { createRequesterSessionControlRuntimeFixture } from '../../../../../cli/src/daemon/testkit/requesterSessionControlRuntimeFixture';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { createCurrentMachineExecutionOriginContextResolver } from '../../../../../cli/src/api/machine/resolveCurrentMachineExecutionOriginContext';
import { ConnectedServiceRuntimeRegistry } from '../../../../../cli/src/daemon/connectedServices/runtimeRegistry/registry';
import { enableSchemaValidation } from '../../../../../server/sources/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '../../../../../server/sources/app/api/utils/enableErrorHandlers';
import { enableAuthentication } from '../../../../../server/sources/app/api/utils/enableAuthentication';
import { enableMonitoring } from '../../../../../server/sources/app/api/utils/enableMonitoring';
import { enableOptionalStatics } from '../../../../../server/sources/app/api/utils/enableOptionalStatics';
import { registerAuthPingRoute } from '../../../../../server/sources/app/api/routes/auth/registerAuthPingRoute';
import { registerAccountApiTokenManagementRoutes } from '../../../../../server/sources/app/api/routes/auth/registerAccountApiTokenManagementRoutes';
import { auth } from '../../../../../server/sources/app/auth/auth';
import { initializeServerIdentityCache } from '../../../../../server/sources/app/serverIdentity/serverIdentity';
import { accountRoutes } from '../../../../../server/sources/app/api/routes/account/accountRoutes';
import { sessionRoutes } from '../../../../../server/sources/app/api/routes/session/sessionRoutes';
import { machinesRoutes } from '../../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { featuresRoutes } from '../../../../../server/sources/app/api/routes/features/featuresRoutes';
import { registerExternalActionRoutes } from '../../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import { startSocket } from '../../../../../server/sources/app/api/socket';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { removeServerProfile } from '@/sync/domains/server/serverProfiles';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import * as React from 'react';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { initializeSessionTerminalWorkspaceForScope } from './sessionTerminalWorkspaceRuntime';
import { readSessionTerminalWorkspace } from './sessionTerminalWorkspace';
import { useMachineTerminalActionAdmission } from '@/hooks/machine/useMachineTerminalActionAdmission';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

// Only the OS PTY process is replaced. The installed local RPC manager,
// registered terminal handlers, PTY manager, Action family and Artifact receipt stay real.

describe('Machine terminal approval receipt across Home aliases (real SQLite)', () => {
    let database: LightSqliteHarness;
    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-r35-terminal-approval-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 180_000);
    afterAll(async () => { if (database) await database.close(); });

    it.each(['browser-profile', 'portable-home', 'foreign-home', 'foreign-target'] as const)(
        'continues %s only for the original member and verified Home', async targetKind => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machineId = crypto.randomUUID();
        const app = createAuthenticatedTestApp();
        artifactsRoutes(app);
        await app.ready();
        const portableHome = `srv_r35_terminal_${owner.id}`;
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: `https://${owner.id}.r35-terminal-approval.test`, accountId: owner.id,
            currentAccount: true }],
            route: async request => {
                const response = await app.inject({ method: request.method, url: request.url.pathname + request.url.search,
                    headers: { 'x-test-user-id': request.accountId ?? '', 'x-happier-account-stored-content-protocol': '4' },
                    ...(request.body === undefined ? {} : { payload: request.body }) });
                return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
            } });
        const home = homes.homes.home!;
        await setServerProfileIdentityForUrl(home.serverUrl, portableHome);
        const account = await captureLazyActionAccountContext(home.id);
        const creatorProfile = 'daemon-local-terminal-profile';
        const actionId = 'machines.terminal.open' as const;
        const member = { id: 'embedded', target: { kind: 'workspace_shell' as const } };
        const identity = resolveSessionTerminalIdentity({ sessionId: 'own-session',
            scopeId: createSessionPaneScopeId('own-session', home.id, 'original-pane'), terminal: member });
        const request = { terminalKey: identity.terminalKey, cwd: database.baseDir, sessionId: 'own-session' };
        const input = getActionSpec(actionId).inputSchema.parse({ ...request, machineId,
            serverId: targetKind === 'foreign-target' ? 'srv_foreign_terminal_home' : creatorProfile });
        // No reusable OS PTY fixture exists in the CLI testkit. Both the PTY
        // and process-tree adapters below are OS boundaries; no real PID is signaled.
        const processes = new Map<number, PtyProcess>();
        const spawn = vi.fn<PtyProvider['spawn']>(() => {
            const outputListeners = new Set<(data: Buffer | string) => void>();
            const exitListeners = new Set<(event: PtyExitEvent) => void>();
            const pid = 4321 + processes.size;
            const process = {
                pid, ownedProcessGroupId: pid,
                write: data => { for (const listener of outputListeners) listener(Buffer.from(data)); },
                resize: () => {},
                kill: () => { for (const listener of exitListeners) listener({ exitCode: 0 }); },
                onData: () => ({ dispose: () => {} }),
                onDataBytes: listener => {
                    outputListeners.add(listener);
                    return { dispose: () => { outputListeners.delete(listener); } };
                },
                onExit: listener => {
                    exitListeners.add(listener);
                    return { dispose: () => { exitListeners.delete(listener); } };
                },
            } satisfies PtyProcess;
            processes.set(pid, process);
            return process;
        });
        const env = { HAPPIER_DAEMON_TERMINAL_ENABLED: '1', SHELL: '/bin/sh' };
        const terminals = createTerminalPtySessionManager({ ptyProvider: { spawn }, env, platform: 'linux',
            config: readDaemonTerminalPtyConfig(env).sessionManager,
            probeProcessGroup: () => 'absent',
            stopProcessTree: async root => {
                const process = processes.get(root.pid);
                if (!process) throw new Error('Unexpected OS process-tree target');
                process.kill();
            },
        });
        const rpc = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId, encryptionMode: 'plain' });
        // This focused producer contract uses the incumbent restricted Session
        // receiver; original shared-Account socket admission is a separate composed gate.
        const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: rpc, deps: {
            serverId: creatorProfile, env, platform: 'linux', workingDirectory: database.baseDir,
            requiredSessionId: 'own-session', sessionManager: terminals,
        } });
        const cliDeps = createCliActionDeps({ token: account.credentials.token, sessionId: 'own-session', serverId: creatorProfile,
            mode: 'plain', ctx: null, machineActionDirectTargetTransport: {
                machineId, invoke: (method, payload, options) => rpc.invokeLocal(method, payload, options),
            } });
        const policy = ActionsSettingsV1Schema.parse({ v: 1 });
        const producer = createActionExecutor({
            ...cliDeps,
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, policy, context),
            approvalsCreate: async ({ request: approval }) => ({ artifactId: await account.createArtifact(
                buildApprovalRequestArtifactHeaderV1(approval), JSON.stringify(ApprovalRequestSchema.parse(approval))) }),
            approvalsGet: async ({ artifactId }) => {
                const artifact = await account.fetchArtifact(artifactId);
                return typeof artifact?.body === 'string' ? ApprovalRequestSchema.parse(JSON.parse(artifact.body)) : null;
            },
            approvalsUpdate: async ({ artifactId, request: approval }) => {
                await account.updateArtifact(artifactId, buildApprovalRequestArtifactHeaderV1(approval), JSON.stringify(approval));
                return { ok: true };
            },
            isApprovalExecutionOriginCurrent: async ({ origin }) => {
                account.assertCurrent();
                return isApprovalExecutionOriginCurrentForAccountContext({ origin, accountServerId: account.serverId, accountId: account.accountId });
            },
        });
        try {
            const proposed = await producer.execute(actionId, input, { surface: 'cli', authority: 'account_automation',
                serverId: creatorProfile, serverIdentityId: targetKind === 'foreign-home' ? 'srv_foreign_terminal_home' : portableHome,
                runtimeAccountId: owner.id, defaultSessionMachineId: machineId,
                actionRequestId: 'terminal-original-request', actionCaller: { kind: 'host' } });
            expect(proposed).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object' || !('artifactId' in proposed.result)
                || typeof proposed.result.artifactId !== 'string') throw new Error('Approval was not created');
            const pending = { artifactId: proposed.result.artifactId, actionId, scope: {
                serverId: targetKind === 'portable-home' ? portableHome : home.id, accountId: owner.id } };
            const original = await account.fetchArtifact(pending.artifactId);
            if (!original) throw new Error('Missing original Artifact');
            const inspected = inspectMachineTerminalMemberApproval({ artifact: original, pending, machineId, request });
            if (targetKind === 'foreign-home' || targetKind === 'foreign-target') {
                expect(inspected).toBeNull();
                const refused = await producer.execute('approval.request.decide',
                    { artifactId: pending.artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user', serverId: creatorProfile });
                expect(refused).toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false,
                    errorCode: targetKind === 'foreign-home' ? 'approval_stale' : 'server_target_mismatch' } } });
                expect(spawn).not.toHaveBeenCalled();
                return;
            }
            expect(inspected, 'The original terminal member must admit its daemon-produced same-Home receipt').not.toBeNull();
            if (!inspected) throw new Error('Original terminal binding was refused');
            const settled: unknown[] = [];
            const continuation = createActionApprovalContinuation({ artifactId: pending.artifactId, actionId, scope: pending.scope,
                expectedInput: inspected.actionArgs, expectedRequestId: inspected.executionOriginV1.requestId,
                expectedExecutionOrigin: inspected.executionOriginV1, onSucceeded: value => { settled.push(value); },
                onFailed: code => { throw new Error(code); } });
            const decided = await producer.execute('approval.request.decide',
                { artifactId: pending.artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user', serverId: creatorProfile });
            expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
            const executed = await account.fetchArtifact(pending.artifactId);
            if (!executed || typeof executed.body !== 'string') throw new Error('Missing executed Artifact');
            const stored: ApprovalRequest = ApprovalRequestSchema.parse(JSON.parse(executed.body));
            expect(stored).toMatchObject({ actionArgs: input, executionOriginV1: { serverId: creatorProfile } });
            expect(inspectMachineTerminalMemberApproval({ artifact: executed, pending, machineId, request })).not.toBeNull();
            expect(await continuation.onExecuted(executed)).toBe('consumed');
            const receipt = DaemonTerminalEnsureResponseSchema.parse(stored.execution?.result);
            expect(receipt).toMatchObject({ ok: true, terminalId: expect.any(String), reused: false });
            expect(getActionSpec(actionId).outputSchema.parse(receipt)).toEqual(receipt);
            expect(settled).toEqual([receipt]);
            if (!receipt.ok) throw new Error('Expected a physical terminal receipt');
            expect(terminals.list()).toMatchObject([{ terminalId: receipt.terminalId,
                terminalKey: request.terminalKey, cwd: request.cwd, sessionId: request.sessionId }]);
            // A new mounted consumer retains the same settled Artifact. It does
            // not replay its approved effect merely to recover the process id.
            const returning: unknown[] = [];
            const returningContinuation = createActionApprovalContinuation({ artifactId: pending.artifactId,
                actionId, scope: pending.scope, expectedInput: inspected.actionArgs,
                expectedRequestId: inspected.executionOriginV1.requestId, expectedExecutionOrigin: inspected.executionOriginV1,
                onSucceeded: value => { returning.push(value); }, onFailed: code => { throw new Error(code); } });
            expect(await returningContinuation.onExecuted(executed)).toBe('consumed');
            expect(returning).toEqual([receipt]);
            expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, request))
                .toEqual({ ok: true, terminalId: receipt.terminalId, reused: true });
            expect(spawn).toHaveBeenCalledTimes(1);
            expect(await db.artifact.count({ where: { accountId: owner.id } })).toBe(1);
            expect(inspectMachineTerminalMemberApproval({ artifact: executed, pending, machineId,
                request: { ...request, terminalKey: `${request.terminalKey}:another-member` } })).toBeNull();
            expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_CLOSE, { terminalId: receipt.terminalId })).toEqual({ ok: true });
            expect(terminals.list()).toEqual([]);
        } finally { registration.dispose(); account.dispose(); await homes.dispose(); await app.close(); }
    });

    it('retains one strict Shell receipt through original Account approval and the installed Machine ingress', async context => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ownerToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const requesterToken = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await initializeServerIdentityCache();
        if (!homeId) throw new Error('Home startup identity missing');
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            installationId: crypto.randomUUID(), active: true,
            metadata: encodePlainMachineStoredContent({ host: 'r35-terminal', platform: 'linux', happyCliVersion: '0.3',
                homeDir: database.baseDir, happyHomeDir: database.baseDir }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
        await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: requester.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const session = await db.session.create({ data: { accountId: requester.id, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadata: JSON.stringify({ machineId: machine.id, path: database.baseDir }) } });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        context.onTestFinished(async () => { await app.close(); });
        enableSchemaValidation(app);
        enableErrorHandlers(app);
        enableAuthentication(app);
        enableMonitoring(app);
        enableOptionalStatics(app);
        registerAuthPingRoute(app);
        registerAccountApiTokenManagementRoutes(app);
        accountRoutes(app);
        featuresRoutes(app);
        artifactsRoutes(app);
        sessionRoutes(app);
        machinesRoutes(app);
        startSocket(app);
        registerExternalActionRoutes(app);
        const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
        let apiMachine: ApiMachineClient | null = null;
        const daemonHomeDir = join(database.baseDir, 'signed-terminal-daemon');
        const daemon = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: daemonHomeDir,
            activeServerDir: join(daemonHomeDir, 'servers', homeId), serverId: homeId, serverHttpBaseUrl: endpoint,
            machineId: machine.id, custodianAccountId: owner.id, credentials: { token: ownerToken, encryption: null },
            connectedServicesMaterializationBaseDir: join(daemonHomeDir, 'connected-services'),
            registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(), getRequester: () => null,
            resolveQualifiedConnectedAccountV4Support: () => 'advertised', getApiMachineForSessions: () => apiMachine,
            startup: { resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                serverUrl: endpoint, resolveCurrentMachineId: () => machine.id,
            }) },
        });
        context.onTestFinished(daemon.dispose);
        // Real installed currentness reads the daemon's retained Account
        // credentials; supplying a constructor token alone is not that custody.
        await writeCredentialsTokenOnlyForServerId(homeId, { token: ownerToken });
        if (!daemon.installation || !daemon.runtime.externalActionIngressOwner) throw new Error('Installed Action owner missing');
        const installation = daemon.installation;
        await db.machine.update({ where: { id: machine.id }, data: { installationId: installation.installationId,
            installationPublicKey: new Uint8Array(decodeBase64(installation.publicKey, 'base64url')) } });
        // Virtual positive process/group identities belong only to this OS
        // fixture. Unexpected process-tree targets fail without signaling a host.
        const processes = new Map<number, PtyProcess>();
        const spawn = vi.fn<PtyProvider['spawn']>(() => {
            const byteListeners = new Set<(data: Buffer | string) => void>();
            const exitListeners = new Set<(event: PtyExitEvent) => void>();
            const pid = 54321 + processes.size;
            const process = { pid, ownedProcessGroupId: pid, write: data => { for (const listener of byteListeners) listener(Buffer.from(data)); },
                resize: () => {}, kill: () => { for (const listener of exitListeners) listener({ exitCode: 0 }); },
                onData: () => ({ dispose: () => {} }),
                onDataBytes: listener => { byteListeners.add(listener); return { dispose: () => { byteListeners.delete(listener); } }; },
                onExit: listener => { exitListeners.add(listener); return { dispose: () => { exitListeners.delete(listener); } }; },
            } satisfies PtyProcess;
            processes.set(pid, process);
            return process;
        });
        const ptyProvider = vi.spyOn(ptyOsBoundary, 'createNodePtyProvider').mockReturnValue({ spawn });
        context.onTestFinished(() => { ptyProvider.mockRestore(); });
        const stopProcessTree = vi.spyOn(processTreeOsBoundary, 'terminateProcessTree').mockImplementation(async root => {
            const process = processes.get(root.pid);
            if (!process) throw new Error('Unexpected OS process-tree target');
            process.kill();
        });
        context.onTestFinished(() => { stopProcessTree.mockRestore(); });
        const probeProcessGroup = vi.spyOn(processGroupOsBoundary, 'probeProcessGroupLiveness').mockImplementation(pid => {
            if (!processes.has(pid)) throw new Error('Unexpected OS process-group probe');
            return 'absent';
        });
        context.onTestFinished(() => { probeProcessGroup.mockRestore(); });
        const ownerApi = await runWithServerHttpBaseUrl(endpoint, () => ApiClient.create({ token: ownerToken, encryption: null }));
        const published = await runWithServerHttpBaseUrl(endpoint, () => ownerApi.getMachine(machine.id));
        if (!published) throw new Error('Installed Machine read missing');
        apiMachine = await runWithServerHttpBaseUrl(endpoint, () => ownerApi.machineSyncClient(published));
        const installed = apiMachine;
        context.onTestFinished(async () => { await installed.shutdown(); });
        const lifecycle = await runWithServerHttpBaseUrl(endpoint, () => installed.setRPCHandlers({
            spawnSession: daemon.runtime.spawnSession, stopSession: daemon.runtime.stopSession,
            isSessionActive: daemon.runtime.isSessionAlreadyRunning,
            requestShutdown: () => { throw new Error('Unexpected OS daemon shutdown request'); },
        }, { currentMachineId: machine.id, currentServerId: homeId, workingDirectory: database.baseDir,
            externalActionIngressOwner: daemon.runtime.externalActionIngressOwner }));
        // The real Machine transport creates its signed installed Socket and
        // owns registration, generation checks and RpcHandlerManager dispatch.
        await runWithServerHttpBaseUrl(endpoint, () => new Promise<void>(resolve => {
            installed.connect({ onConnect: resolve });
        }));
        const actionHttp: Array<Readonly<{ path: string; status: number; originServerId?: string; serverIdentityId?: string }>> = [];
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: endpoint, accountId: requester.id, currentAccount: true }],
            route: async request => {
                const response = await app.inject({ method: request.method, url: request.url.pathname + request.url.search,
                    headers: Object.fromEntries(request.headers), ...(request.body === undefined ? {} : { payload: request.body }) });
                if (request.url.pathname.startsWith('/v1/actions/')) {
                    const body = request.body && typeof request.body === 'object' ? request.body : null;
                    const envelope = body && 'envelope' in body ? body.envelope : body;
                    const input = envelope && typeof envelope === 'object' && 'input' in envelope ? envelope.input : null;
                    actionHttp.push({ path: request.url.pathname, status: response.statusCode,
                        ...(input && typeof input === 'object' && 'originServerId' in input && typeof input.originServerId === 'string'
                            ? { originServerId: input.originServerId } : {}),
                        ...(input && typeof input === 'object' && 'serverIdentityId' in input && typeof input.serverIdentityId === 'string'
                            ? { serverIdentityId: input.serverIdentityId } : {}),
                    });
                }
                return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
            } });
        context.onTestFinished(homes.dispose);
        const learned = await setServerProfileIdentityForUrl(endpoint, homeId);
        if (!learned) throw new Error('Home identity missing');
        context.onTestFinished(async () => { await removeServerProfile(learned.id); });
        const credentials = await TokenStorage.setCredentialsForServerUrlWithRollback(endpoint,
            { serverId: learned.id }, { token: requesterToken });
        if (!credentials) throw new Error('Requester credential missing');
        context.onTestFinished(async () => { if (!await credentials.rollback()) throw new Error('Requester credential rollback failed'); });
        const member = { id: 'embedded', target: { kind: 'workspace_shell' as const } };
        const scopeId = createSessionPaneScopeId(session.id, learned.id, 'original-pane');
        const request = { terminalKey: resolveSessionTerminalIdentity({ sessionId: session.id, scopeId, terminal: member }).terminalKey,
            cwd: database.baseDir, sessionId: session.id };
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const wrapper: React.ComponentType<React.PropsWithChildren> = ({ children }) => React.createElement(AppPaneProvider, null, children);
        const paneHost = await renderHook(() => null, { wrapper });
        context.onTestFinished(paneHost.unmount);
        await act(async () => {
            expect(initializeSessionTerminalWorkspaceForScope(scopeId, readSessionTerminalWorkspace(undefined))).toBe(true);
        });
        const actionId = 'machines.terminal.open' as const;
        const executor = createDefaultActionExecutor();
        const uiContext = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
            serverId: learned.id, actionRequestId: crypto.randomUUID() };
        const proposed = await executor.execute(actionId, { ...request, machineId: machine.id, serverId: learned.id }, uiContext);
        expect(proposed).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object' || !('artifactId' in proposed.result)
            || typeof proposed.result.artifactId !== 'string') throw new Error('Original approval missing');
        const artifactId = proposed.result.artifactId;
        // Observe with the current Account context after real front-door
        // admission, not an earlier setup-only scope lease.
        const account = await captureLazyActionAccountContext(learned.id);
        context.onTestFinished(account.dispose);
        const proposalArtifact = await account.fetchArtifact(artifactId);
        if (!proposalArtifact || typeof proposalArtifact.body !== 'string') throw new Error('Original proposal Artifact missing');
        const proposal = ApprovalRequestSchema.parse(JSON.parse(proposalArtifact.body));
        if (proposal.v !== 2) throw new Error('Original proposal origin missing');
        const nativeOrigin = await createCurrentMachineExecutionOriginContextResolver({ serverUrl: endpoint,
            resolveCurrentMachineId: () => machine.id })();
        const nativeCurrentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
            credentials: { token: requesterToken, encryption: null }, machineId: machine.id, serverId: homeId, serverApiUrl: endpoint });
        const originSummary = { serverId: proposal.executionOriginV1.serverId,
            serverIdentityId: proposal.executionOriginV1.serverIdentityId,
            accountId: proposal.executionOriginV1.accountId, machineId: proposal.executionOriginV1.machineId,
            targetKind: proposal.executionOriginV1.target?.kind,
            callerPermissionMode: proposal.executionOriginV1.callerPermissionMode === undefined ? 'omitted' : proposal.executionOriginV1.callerPermissionMode,
            hasSessionAgentSpawnPolicy: proposal.executionOriginV1.sessionAgentSpawnPolicyV1 !== undefined,
            nativeOrigin, nativeCurrent: await nativeCurrentness?.({ origin: proposal.executionOriginV1, request: proposal }),
        };
        const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' },
            { ...uiContext, actionRequestId: crypto.randomUUID() });
        const decisionResult = decided.ok && decided.result && typeof decided.result === 'object' ? decided.result : null;
        const execution = decisionResult ? Reflect.get(decisionResult, 'execution') : null;
        // An approval may carry signed custody. Failure diagnostics project
        // only statuses/codes, never the retained authorization or bearer.
        const decisionSummary = { ok: decided.ok, status: decisionResult ? Reflect.get(decisionResult, 'status') : null,
            executionOk: execution && typeof execution === 'object' ? Reflect.get(execution, 'ok') : null,
            errorCode: decided.ok ? execution && typeof execution === 'object' ? Reflect.get(execution, 'errorCode') : null : decided.errorCode,
            physicalBirths: spawn.mock.calls.length,
            actionHttp,
            originSummary,
        };
        expect(decisionSummary, JSON.stringify(decisionSummary)).toMatchObject({ ok: true, status: 'executed', executionOk: true });
        const artifact = await account.fetchArtifact(artifactId);
        if (!artifact || typeof artifact.body !== 'string') throw new Error('Executed original Artifact missing');
        const approval = ApprovalRequestSchema.parse(JSON.parse(artifact.body));
        const receipt = DaemonTerminalEnsureResponseSchema.parse(getActionSpec(actionId).outputSchema.parse(approval.execution?.result));
        expect(receipt).toMatchObject({ ok: true, terminalId: expect.any(String), reused: false });
        if (!receipt.ok) throw new Error('Expected a physical terminal receipt');
        const settled: unknown[] = [];
        if (approval.v !== 2) throw new Error('Original execution origin missing');
        const continuation = createActionApprovalContinuation({ artifactId, actionId, scope: account.accountLifetime.scope,
            expectedInput: approval.actionArgs, expectedRequestId: approval.executionOriginV1.requestId,
            expectedExecutionOrigin: approval.executionOriginV1,
            onSucceeded: value => { settled.push(value); }, onFailed: code => { throw new Error(code); } });
        expect(await continuation.onExecuted(artifact)).toBe('consumed');
        expect(settled).toEqual([receipt]);
        const census = await executor.execute('machines.terminal.list', { machineId: machine.id, serverId: learned.id }, uiContext);
        expect(census).toMatchObject({ ok: true, result: { ok: true, terminals: [{ terminalId: receipt.terminalId,
            terminalKey: request.terminalKey, cwd: request.cwd, sessionId: request.sessionId }] } });
        // The pane/member outlives its view. Both the returning view and its
        // remount recover actual requester custody through the real census;
        // neither carries a cached process id nor asks to approve another open.
        for (const mount of ['returning', 'reopened'] as const) {
            const hook = await renderHook(() => useMachineTerminalActionAdmission({ terminalKey: request.terminalKey,
                machineId: machine.id, serverId: learned.id, scopeId, memberId: member.id }));
            const interest = new AbortController();
            let observed: Awaited<ReturnType<ReturnType<typeof useMachineTerminalActionAdmission>['admit']>> | undefined;
            const admission = hook.getCurrent().admit(request, false, interest.signal).then(value => { observed = value; return value; });
            try {
                await vi.waitFor(() => expect(observed !== undefined || hook.getCurrent().approvalPending).toBe(true), { timeout: 30_000 });
                expect(observed, mount).toEqual({ ok: true, terminalId: receipt.terminalId, reused: true });
                expect(hook.getCurrent().approvalPending).toBe(false);
                expect(await db.artifact.count({ where: { accountId: requester.id } })).toBe(1);
            } finally { interest.abort(); await admission; await hook.unmount(); }
        }
        expect(lifecycle.getFiniteTerminalSessions().list()).toHaveLength(1);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(await db.artifact.count({ where: { accountId: requester.id } })).toBe(1);
        const terminals = lifecycle.getFiniteTerminalSessions();
        expect(await terminals.requestStop({ terminalId: receipt.terminalId })).toMatchObject({ kind: 'requested' });
        expect(await terminals.waitForExit({ terminalId: receipt.terminalId })).toMatchObject({ kind: 'exited' });
    }, 180_000);
});
