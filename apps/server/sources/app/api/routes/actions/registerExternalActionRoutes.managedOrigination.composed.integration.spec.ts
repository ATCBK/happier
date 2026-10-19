import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Server } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    MACHINE_PLAIN_DATA_KEY_MARKER, PluginManifestV2Schema, encodePlainMachineStoredContent,
    MachineOperationProtocolCapabilitiesV1Schema, signAccountContentKeyBindingV1,
} from '@happier-dev/protocol';
import { ExternalActionDaemonDispatchRequestSchema, createExternalActionDaemonDispatchResponseV1 } from '@happier-dev/protocol/actions';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import {
    defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema,
    MachineProvisionerPowerResultV1Schema,
} from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { createExternalActionDaemonDispatcher, type ExternalActionForwardRpcCall } from '@/app/api/socket/externalActionDispatcher';
import { auth } from '@/app/auth/auth';
import { verifyCurrentExternalActionPrincipal } from '@/app/auth/externalActionExecutionAuthorization';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { resolveMachineAccess } from '@/app/machines/machineAccess';
import { db, initDbPostgres } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { deriveAccountEncryptionCurrentnessFromRow } from '@/app/encryption/accountContentKeyAdmission';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { handleActionsCommand } from '../../../../../../cli/src/cli/commands/actions';
import { createCliActionExecutorFromCredentials } from '../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionExecutor } from '../../../../../../cli/src/session/actions/createCliActionExecutor';
import { executeExternalAction } from '../../../../../../cli/src/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '../../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { installAxiosFastifyAdapter } from '../../../../../../cli/src/testkit/http/axiosAdapter';
import { accountSettingsParse, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '../../../../../../cli/src/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '../../../../../../cli/src/settings/accountSettings/accountSettingsScopeKey';
import { createAccountServerActionDeps } from '../../../../../../cli/src/api/accountServerActionDeps';
import { createActionExecutor } from '@happier-dev/protocol';
import { seedBundledManagedAvailability } from '@/app/machines/managed/managedProjectionVolume.testkit';
import { managedQb56Input, managedQb56RequestId } from './managedQb56Input.testkit';
import { snapshotEnv, restoreEnv } from '@/testkit/env';

describe('composed CLI managed Action origination', () => {
    const homeId = managedQb56Input.selection.homeId;
    const capabilities = MachineOperationProtocolCapabilitiesV1Schema.parse({ externalActionExecutionAuthorization: { protocolVersions: [1] } });
    let harness: LightSqliteHarness;
    const initialEnv = snapshotEnv();
    beforeAll(async () => {
        if (process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            if (process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
                throw new Error('Use only the disposable PostgreSQL DB-contract harness');
            }
            Object.assign(process.env, { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' });
            process.env.HANDY_MASTER_SECRET = crypto.randomUUID();
            initDbPostgres();
            await db.$connect();
            await auth.init();
            return;
        }
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-origination-', initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
    }, 120_000);
    afterAll(async () => {
        try { if (harness) await harness.close(); else await db.$disconnect(); }
        finally { restoreEnv(initialEnv); }
    });

    async function fixture(online: boolean, mode: 'plain' | 'e2ee' = 'plain', qb56 = false) {
        const signing = mode === 'e2ee' ? tweetnacl.sign.keyPair() : null;
        const content = signing ? tweetnacl.box.keyPair() : null;
        const account = await db.account.create({ data: { encryptionMode: mode,
            publicKey: signing ? Buffer.from(signing.publicKey).toString('hex') : null,
            ...(signing && content ? { contentPublicKey: new Uint8Array(content.publicKey),
                contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey,
                    contentPublicKey: content.publicKey }) } : {}) } });
        expect(deriveAccountEncryptionCurrentnessFromRow(account),
            'Fixture must satisfy the real Account-mode/content-key admission before Session creation')
            .toMatchObject({ status: 'ready', currentness: { encryptionMode: mode } });
        const keys = tweetnacl.sign.keyPair();
        const controller = qb56 ? managedQb56Input.selection.controller
            : { machineId: crypto.randomUUID(), installationId: crypto.randomUUID() };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id,
            metadata: mode === 'e2ee' ? 'retained-machine-ciphertext' : encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            dataEncryptionKey: mode === 'e2ee' ? null : decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: controller.installationId, installationPublicKey: new Uint8Array(keys.publicKey),
            active: online, pluginMaterializationRevision: BigInt(1),
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: capabilities } });
        expect(await resolveMachineAccess({ actorAccountId: account.id, machineId: controller.machineId }),
            'Origination fixture must be ready before online placement under the real Machine-mode owner').toMatchObject({
            owned: true, role: 'manage', encryptionMode: mode, accessState: 'ready', installationId: controller.installationId,
        });
        if (qb56) {
            await seedBundledManagedAvailability(account.id, homeId, controller);
            const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
            return { account, controller, keys, token, input: managedQb56Input, requestId: managedQb56RequestId };
        }
        const launch = defineProtocolObject({ image: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const native = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const roles = defineMachineProvisionerSchemas({ launch, resource: native });
        const actions = [
            { id: 'check', inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
            { id: 'acquire', inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
            { id: 'bootstrap', inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
            { id: 'inspect', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
            { id: 'destroy', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
        ];
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'fixture.origination', version: '1.0.0',
            displayName: 'Compute', description: 'Managed origination fixture', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {
                machineProvisioners: [{ id: 'compute', title: 'Compute', icon: 'machine', resourceKind: 'VM', schemaVersion: 1,
                    launchSchema: launch.jsonSchema, resourceSchema: native.jsonSchema, platforms: ['linux'], prerequisites: [],
                    billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['delete'] },
                    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' } }],
                actions: actions.map(action => ({ ...action, title: action.id, execution: { target: 'daemon' },
                    surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe' })),
            } });
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: manifest.id, enabled: true,
            writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: homeId,
            machineId: controller.machineId, materializationId: controller.installationId, pluginId: manifest.id,
            version: manifest.version, sourceClass: 'bundledFirstParty', portableRelease: false,
            archiveDigestSha256: declaration.manifestDigestSha256, uiArtifacts: [], enabled: true,
            trustState: 'trusted', observedAt: new Date() } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const input = { selection: { kind: 'one-off' as const, homeId, controller,
            launch: { provider: { pluginId: manifest.id, localId: 'compute' }, schemaVersion: 1, name: 'Reviewed', choices: { image: 'linux' } },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
        return { account, controller, keys, token, input, requestId: crypto.randomUUID() };
    }

    async function app(forwardRpc: ExternalActionForwardRpcCall, configureHttp: (instance: AppFastify) => void,
        phases: Array<{ phase: string; elapsedMs: number; status?: number }>) {
        const instance = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        instance.setValidatorCompiler(validatorCompiler);
        instance.setSerializerCompiler(serializerCompiler);
        const starts = new WeakMap<object, number>();
        instance.addHook('onRequest', async request => { starts.set(request, performance.now()); });
        instance.addHook('onResponse', async (request, reply) => {
            phases.push({ phase: `${request.method} ${request.routeOptions.url}`, status: reply.statusCode,
                elapsedMs: performance.now() - (starts.get(request) ?? performance.now()) });
        });
        enableAuthentication(instance);
        // Only socket delivery is substituted; routes, admission, auth and dispatch stay real.
        registerExternalActionRoutes(instance, { dispatch: createExternalActionDaemonDispatcher({ io: {} as Server, forwardRpc }) });
        machinesRoutes(instance);
        configureHttp(instance);
        await instance.ready();
        return instance;
    }

    it.each(['valid', 'invalid', 'qb56'] as const)('invokes managed Create through CLI, Home and the real approval executor with %s refreshed policy', async policy => {
        const selected = await fixture(true, 'plain', policy === 'qb56');
        const credentials = { token: selected.token, credentialProvenance: 'stored_session' as const, encryption: null };
        const storedSettings = { actionsSettingsV1: { v: 1, actions: {
            'machines.managed.acquire': { approvalRequiredSurfaces: ['ui'] },
        } } };
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(storedSettings),
            rawSettings: storedSettings, settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials) });
        const approvals: unknown[] = [];
        const phases: Array<{ phase: string; elapsedMs: number; status?: number }> = [];
        let effects = 0;
        const receiver = createCliActionExecutor({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
            serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: 'http://managed-seam.test',
            externalActionMachineRequestPrivateKey: selected.keys.secretKey,
            externalActionMachineInstallationId: selected.controller.installationId,
            managedMachineAction: async () => { effects++; throw new Error('Create must ask before native execution'); },
        });
        const instance = await app(async request => {
            const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            const result = await executeExternalAction({ ...admitted, executor: receiver,
                currentMachineId: selected.controller.machineId, currentInstallationId: selected.controller.installationId,
                currentServerId: homeId, externalActionMachineRequestPrivateKey: selected.keys.secretKey,
                // Socket delivery is substituted; its current Home proof is verified by the real HTTP port.
                verifyExecutionAuthorization: async ({ authorization }) => {
                    return await verifyCurrentExternalActionPrincipal(authorization.binding) !== null;
                },
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
            });
            if (result.kind !== 'response') throw new Error(`Daemon rejected managed ingress: ${result.kind}`);
            return { ok: true, result: createExternalActionDaemonDispatchResponseV1(result.prepared) };
        }, http => {
            http.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
            http.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: storedSettings },
                version: policy === 'invalid' ? 'invalid' : 2 }));
            http.post('/v1/artifacts', async request => {
                const raw = request.body;
                if (!raw || typeof raw !== 'object' || !('id' in raw) || typeof raw.id !== 'string'
                    || !('body' in raw) || typeof raw.body !== 'string') throw new Error('Invalid Artifact request');
                const stored = decodePlainArtifactStoredContent(raw.body);
                if (!stored || typeof stored !== 'object' || !('body' in stored) || typeof stored.body !== 'string') {
                    throw new Error('Invalid approval Artifact body');
                }
                approvals.push(ApprovalRequestV2Schema.parse(JSON.parse(stored.body)));
                return { id: raw.id, headerVersion: 1, bodyVersion: 1 };
            });
        }, phases);
        const restoreHttp = installAxiosFastifyAdapter({ app: instance, origin: 'http://managed-seam.test' });
        const began = performance.now();
        let output = '';
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
            output += String(chunk);
            const callback = args.find(argument => typeof argument === 'function');
            if (typeof callback === 'function') callback();
            return true;
        });
        const previousExitCode = process.exitCode;
        try {
            await handleActionsCommand(['invoke', 'machines.managed.acquire', '--machine-id', selected.controller.machineId,
                '--request-id', selected.requestId, '--input-json', JSON.stringify(selected.input), '--json'], {
                readCredentialsFn: async () => credentials,
                getServerProfileFn: async () => { throw new Error('No saved profile in this isolated fixture'); },
                createExecutorFn: options => createCliActionExecutorFromCredentials({ ...options,
                    serverId: homeId, serverIdentityId: homeId, serverApiUrl: 'http://managed-seam.test' }),
            });
            phases.push({ phase: 'cli-create-to-ask', elapsedMs: performance.now() - began });
            expect(JSON.parse(output)).toMatchObject(policy === 'invalid'
                ? { ok: false, kind: 'actions_invoke', error: { code: 'ACCOUNT_SETTINGS_CONTENT_INVALID' } }
                : { ok: true, kind: 'actions_invoke', data: { kind: 'approval_request_created', actionId: 'machines.managed.acquire' } });
            expect(approvals).toHaveLength(policy === 'invalid' ? 0 : 1);
            expect(effects).toBe(0);
            // Home admission precedes controller policy preparation. A refused
            // refresh cannot roll back that already committed request.
            expect(await db.managedMachine.count({ where: { homeId, admittedActionRequestId: selected.requestId } })).toBe(1);
            if (policy === 'qb56') {
                const row = await db.managedMachine.findFirstOrThrow({ where: { homeId, admittedActionRequestId: selected.requestId } });
                expect(row).toMatchObject({ allocation: 'unsubmitted', creationState: 'active', intentRevision: 0 });
                const started = performance.now();
                const executor = createActionExecutor(createAccountServerActionDeps({ token: credentials.token,
                    serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: 'http://managed-seam.test' }) as Parameters<typeof createActionExecutor>[0]);
                // Replay of an already approved Account Cancel; the actual Home
                // authority, route, transaction and strict acknowledgement remain real.
                const canceled = await executor.execute('machines.managed.cancel', { homeId, managedId: row.id,
                    expectedIntentRevision: 0 }, { surface: 'cli', authority: 'present_user', bypassApprovals: true });
                phases.push({ phase: 'cli-approved-cancel', elapsedMs: performance.now() - started });
                expect(canceled).toMatchObject({ ok: true, result: { machine: { id: row.id,
                    creationState: 'canceled', allocation: 'confirmed-absent', intentRevision: 1 } } });
                expect(await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } }))
                    .toMatchObject({ creationState: 'canceled', allocation: 'confirmed-absent', intentRevision: 1 });
            }
        } finally {
            stdout.mockRestore(); process.exitCode = previousExitCode;
            restoreHttp(); resetActiveAccountSettingsSnapshotForTests(); await instance.close();
            if (policy === 'qb56') console.info('qb58-replay-phases', JSON.stringify(phases));
        }
    });
});
