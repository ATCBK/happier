import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'socket.io';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams';
import codexManifest from '../../../assets/bundled-plugin-manifests/codex.json';
import gatewayManifest from '../../../assets/bundled-plugin-manifests/cliproxyapi.json';
import { CODEX_PROVIDER_BINDING_ADAPTER_V1 } from '../../../../../packages/plugins/codex/src/agent/providerBinding/adapter';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { createProviderRuntimeStateStore } from '@/providers/runtimeState';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { registerMachineProviderRpcHandlers } from '@/api/machine/rpcHandlers.providers';
import { resolveTeamCredentialSourceModelCatalog } from '@/providers/broker/resourceTestCandidate';
import { projectManagedProviderBrokerApplication, resolveManagedProviderBrokerPurpose } from '@/providers/broker/applicationProjection';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { RpcHandlerManager } from './RpcHandlerManager';
import type { RpcRequest } from './types';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';

// The CLI harness resolves each host's source aliases from its importing file.
const forwarderPath = '../../../../server/sources/app/api/socket/serverRpcForwarder';
const eligibilityPath = '../../../../server/sources/app/teams/credentials/poolSourceEligibility';
const { createServerRpcForwarder }: typeof import('../../../../server/sources/app/api/socket/serverRpcForwarder') = await import(forwarderPath);
const { createTeamCredentialPoolSourceEligibilityReader }: typeof import('../../../../server/sources/app/teams/credentials/poolSourceEligibility') = await import(eligibilityPath);

const accountId = 'account-1';
const machineId = 'machine-1';
const method = `${machineId}:${RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_BROKER_ELIGIBILITY}`;
const input = { machineId, teamId: 'team-1', resourceId: 'resource-1', expectedResourceRevision: 1,
    source: { kind: 'provider_connection' as const, connectionId: 'connection-1',
        connectionSecurityFingerprint: 'fingerprint-1', credentialSlotId: 'slot-1' }, scope: 'source_any' as const };
const eligible = { status: 'eligible' as const };

afterEach(() => resetActiveAccountSettingsSnapshotForTests());

function createDaemon() {
    let executions = 0;
    const manager = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId,
        encryptionKey: new Uint8Array(32).fill(43), encryptionVariant: 'dataKey', logger: () => {},
        authorizeRequest: request => authorizeMachineRpcRequest(request, {
            machineId,
            // Model the installed identity and authenticated Home boundaries only.
            resolveCustodianAccountId: async () => accountId,
            resolveInstallationId: () => 'installation-1',
            verifyMachineAdmission: async () => true,
        }),
    });
    manager.registerHandler(RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_BROKER_ELIGIBILITY, params => {
        expect(params).toEqual(input);
        executions += 1;
        return eligible;
    });
    return { manager, executions: () => executions };
}

function createTransport(manager: RpcHandlerManager, replies: unknown[] = []) {
    // Socket.IO discovery/delivery is the only modeled server-to-daemon boundary.
    const target = { id: 'daemon-socket', timeout: () => ({ emitWithAck: async (event: string, request: RpcRequest) => {
        expect(event).toBe(SOCKET_RPC_EVENTS.REQUEST);
        const reply = await manager.handleRequest(request);
        replies.push(reply);
        return reply;
    } }) };
    return { in: (room: string) => ({ timeout: () => ({ fetchSockets: async () =>
        room.startsWith(`rpc:${accountId}:${machineId}:`) ? [target] : [] }) }) } as unknown as Server;
}

describe('server-origin Machine reads across the E2EE RPC seam', () => {
    it('admits a connected Codex source through the real model projector without a saved Provider connection', async () => {
        const home = await mkdtemp(join(tmpdir(), 'connected-codex-eligibility-'));
        try {
            // OPS8/OPS9's source picker selects this qualified Connected Account.
            // resourceSourceCandidates pins the credential row id as its incarnation.
            const source = TeamCredentialSourceBindingV1Schema.parse({
                v: 1, kind: 'connected_account',
                target: { kind: 'account', account: {
                    service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                    accountId: '97bd5614-8970-4068-87f2-1447de69d604',
                } },
                credentialIncarnation: 'cmuwo1t4m000etm32p8ydij7j',
            });
            const { catalog } = splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1);
            const snapshot = {
                source: 'cache' as const, settings: AccountSettingsSchema.parse({}),
                providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog },
                savedSecretResources: [], savedSecretCatalogState: 'ready' as const,
                settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'connected-codex-account',
            };
            setActiveAccountSettingsSnapshot(snapshot);
            const agent = codexManifest.contributes.agents.find(candidate => candidate.id === 'codex')!;
            const gateway = gatewayManifest.contributes.providers[0]!;
            // Loaded-plugin and OS/storage boundaries only: use the actual bundled
            // declarations and Codex adapter, with no mocked projector/eligibility.
            const executable = {
                generation: 7,
                contributes: {
                    agentDefinitionsById: new Map([['codex', { id: 'codex', pluginId: codexManifest.id,
                        identity: { pluginId: codexManifest.id, localId: 'codex' }, definition: agent }]]),
                    providersByContributionKey: new Map([[`${gatewayManifest.id}/${gateway.id}`, {
                        identity: { pluginId: gatewayManifest.id, localId: gateway.id }, pluginId: gatewayManifest.id,
                        definition: gateway, provenance: 'bundled', source: { kind: 'path' },
                    }]]),
                },
                activateContributionsOnDemand: async () => [],
                agentRuntimesByAgentId: new Map([['codex', {
                    pluginId: codexManifest.id, pluginVersion: codexManifest.version, agentId: 'codex',
                    generation: 'connected-codex-fixture', providerBinding: CODEX_PROVIDER_BINDING_ADAPTER_V1,
                    isCurrent: () => true, retirementSignal: new AbortController().signal,
                }]]),
            } as unknown as ResolvedExecutablePluginRuntimeRegistry;
            const unused = async (): Promise<never> => { throw new Error('Unexpected effect during eligibility'); };
            if (source.kind !== 'connected_account') throw new Error('Expected Connected Account source');
            const connectedAccounts = createConnectedAccountPurposeBindingOwner({
                store: { read: async () => ({ v: 1, bindings: [] }), update: unused, subscribe: () => ({ dispose() {} }) },
                selectTarget: unused,
                resolveTarget: async (target, signal) => {
                    signal.throwIfAborted();
                    return target.kind === 'account' && target.account.accountId === source.target.account.accountId
                        ? { account: source.target.account, displayName: 'Happier Devs' } : null;
                },
                materializeAccount: unused, projectTargetAccounts: unused, assertTargetAccountMaterializable: unused,
            });
            const runtime = createRuntimeProviderModelManagementServices({ machineId, happyHomeDir: home,
                featureGate: { isEnabled: () => true }, getAccountSettingsSnapshot: () => snapshot,
                runtimeStore: createProviderRuntimeStateStore({ happyHomeDir: home, machineId }),
                acquireRuntimeLease: async () => ({ registry: executable, source: 'active', durableRevision: -1, release: async () => {} }),
                resolveManagedPurposeBindingIntent: connectedAccounts.resolveBindingIntent,
                modelSettingsMutation: unused,
            });
            const daemon = createDaemon();
            registerMachineProviderRpcHandlers({ rpcHandlerManager: daemon.manager, machineId,
                featureGate: { isEnabled: () => true }, services: { ...runtime,
                    prepareProfileMigrationSource: unused, describeConnections: unused, mutateConnection: unused,
                    previewProfileMigration: unused, confirmProfileMigration: unused, confirmProfileMigrationConflict: unused,
                },
            });
            const replies: unknown[] = [];
            const readEligibility = createTeamCredentialPoolSourceEligibilityReader(createServerRpcForwarder({
                io: createTransport(daemon.manager, replies),
            }));
            const result = await readEligibility({ custodianAccountId: accountId, machineIds: [machineId],
                teamId: input.teamId, resourceId: input.resourceId, resourceRevision: 1, source,
                scope: 'source_any', signal: new AbortController().signal });
            const agentTargetKey = `agent:${codexManifest.id}/${agent.id}`;
            const projection = await runtime.projectModels({ machineId, agentTargetKey,
                connectedAccountTarget: source.target, refreshPolicy: 'current_only', mode: 'picker' });
            expect(projection).toMatchObject({ status: 'success', agentTargetKey });
            const application = projectManagedProviderBrokerApplication({
                registry: resolveProviderContributionRegistryView(executable.contributes, executable.generation!),
                implementationIdentity: { pluginId: gatewayManifest.id, localId: gateway.id },
                agentTargetKey, protocol: 'openai-responses',
            });
            expect(application).not.toBeNull();
            if (!application) throw new Error('Expected admitted managed broker application');
            const family = resolveManagedProviderBrokerPurpose({
                registry: resolveProviderContributionRegistryView(executable.contributes, executable.generation!),
                application, service: source.target.account.service,
            });
            if (!family) throw new Error('Expected the declared Connected Account purpose');
            const selection = await connectedAccounts.resolveBindingIntentSelection({
                purpose: { consumer: application.implementationIdentity, purpose: family.purpose },
                target: source.target, serviceRefs: [source.target.account.service], signal: new AbortController().signal,
            });
            expect(await selection.isCurrent()).toBe(true);
            expect(replies).toEqual([eligible]);
            expect([...result.eligibleMachineIds]).toEqual([machineId]);
            if (projection.status !== 'success') throw new Error('Expected source model projection');
            expect(projection.groups.some(group => group.authorization.authorized && group.rows.length > 0)).toBe(true);
            await expect(runtime.resolveTeamCredentialResourceTestCandidate({ machineId,
                teamId: input.teamId, resourceId: input.resourceId, expectedResourceRevision: 1,
                source, refreshPolicy: 'current_only',
            })).resolves.toMatchObject({ status: 'success' });
            await expect(runtime.resolveTeamCredentialRequestPolicySupport({ machineId, source,
                refreshPolicy: 'current_only',
            })).resolves.toMatchObject({ status: 'success' });
            await expect(resolveTeamCredentialSourceModelCatalog({ machineId,
                teamId: input.teamId, resourceId: input.resourceId, resourceRevision: 1,
                source, application, projectModels: request => runtime.projectModels({ ...request, refreshPolicy: 'current_only' }),
            })).resolves.not.toBeNull();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('composes the real server eligibility caller and forwarder with the E2EE daemon', async () => {
        const daemon = createDaemon();
        const replies: unknown[] = [];
        const io = createTransport(daemon.manager, replies);
        const readEligibility = createTeamCredentialPoolSourceEligibilityReader(createServerRpcForwarder({ io }));
        const result = await readEligibility({ custodianAccountId: accountId, machineIds: [machineId],
            teamId: input.teamId, resourceId: input.resourceId, resourceRevision: 1, source: input.source,
            scope: 'source_any', signal: new AbortController().signal });
        expect(replies).toEqual([eligible]);
        expect([...result.eligibleMachineIds]).toEqual([machineId]);
        expect(daemon.executions()).toBe(1);
    });

    it.each([
        RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
        RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
        RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_REQUEST_POLICY_SUPPORT,
        RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_RESOURCE_TEST_CANDIDATE,
        RPC_METHODS.DAEMON_EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE,
        SESSION_RPC_METHODS.EXECUTION_RUN_FOLLOW_FRONTIER,
    ])('admits the adjacent real server read through the same E2EE seam: %s', async readMethod => {
        const { manager } = createDaemon();
        const projection = { status: 'current', value: readMethod };
        manager.registerHandler(readMethod, () => projection);
        const forward = createServerRpcForwarder({ io: createTransport(manager) });
        expect(await forward({ userId: accountId, method: `${machineId}:${readMethod}`, params: { machineId } }))
            .toEqual({ ok: true, result: projection });
    });

    it('keeps arbitrary server-forwarded methods encrypted even with a valid read stamp', async () => {
        const { manager } = createDaemon();
        let executed = false;
        manager.registerHandler('demo.other', () => { executed = true; return { ok: true }; });
        const forward = createServerRpcForwarder({ io: createTransport(manager) });
        expect(await forward({ userId: accountId, method: `${machineId}:demo.other`, params: {} }))
            .toMatchObject({ ok: true, result: { errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED } });
        expect(await manager.handleRequest({ method: `${machineId}:demo.other`, params: {},
            authorization: { kind: 'machine.read.serverOrigin', accountId, machineId } }))
            .toMatchObject({ errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED });
        expect(executed).toBe(false);
    });

    it('requires the installed Machine authorization boundary before opening a Home read', async () => {
        const manager = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId,
            encryptionKey: new Uint8Array(32).fill(43), encryptionVariant: 'dataKey', logger: () => {} });
        const forward = createServerRpcForwarder({ io: createTransport(manager) });
        expect(await forward({ userId: accountId, method, params: input }))
            .toMatchObject({ ok: true, result: { errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED } });
    });

    it('distinguishes retired RPC material from object rejection by the E2EE codec', async () => {
        const { manager } = createDaemon();
        expect(await manager.handleRequest({ method, params: input })).toEqual({
            error: 'Encrypted RPC binding is unavailable or invalid; update all Happier components',
            errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED,
        });
        manager.retireEncryptionContext();
        expect(await manager.handleRequest({ method, params: input })).toEqual({
            error: 'RPC encryption material is unavailable', errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED,
        });
    });

    it.each([
        { authorization: undefined, errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED },
        { authorization: { kind: 'machine.read.serverOrigin', accountId, machineId: 'machine-2' }, errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED },
        { authorization: { kind: 'machine.read.serverOrigin', accountId: 'account-2', machineId }, errorCode: RPC_ERROR_CODES.FORBIDDEN },
        { authorization: { kind: 'machine.read.serverOrigin', accountId, machineId, forged: true }, errorCode: RPC_ERROR_CODES.UPDATE_REQUIRED },
    ])('refuses raw eligibility with absent or mis-bound authority: $authorization', async ({ authorization, errorCode }) => {
        const daemon = createDaemon();
        const reply = await daemon.manager.handleRequest({ method, params: input, authorization } as RpcRequest);
        expect(reply).toMatchObject({ errorCode });
        expect(daemon.executions()).toBe(0);
    });

    it('preserves ordinary encrypted eligibility calls', async () => {
        const { manager } = createDaemon();
        // Real bound codec, using an in-memory cipher boundary for the ordinary client path.
        const { encrypt, decrypt, encodeBase64, decodeBase64 } = await import('@/api/encryption');
        const key = new Uint8Array(32).fill(43);
        const content = { mode: 'e2ee' as const, cipher: {
            encryptRaw: async (value: unknown) => encodeBase64(encrypt(key, 'dataKey', value)),
            decryptRaw: async (value: string) => decrypt(key, 'dataKey', decodeBase64(value)),
        } };
        const callId = '0123456789abcdef0123456789abcdef';
        const params = await socketRpcCodec.encodeParams(content, input, { method, callId });
        const result = await manager.handleRequest({ method, params });
        expect(typeof result).toBe('string');
        expect(await socketRpcCodec.decodeResult(content, { ok: true, result }, callId)).toEqual(eligible);
    });
});
