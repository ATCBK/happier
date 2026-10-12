import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { AccountSettingsSchema, decodeBase64, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { SetSessionPinResponseSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { registerAccountEncryptionRoutes } from '../account/registerAccountEncryptionRoutes';
import { registerAccountSettingsRoutes } from '../account/registerAccountSettingsRoutes';
import { registerSessionListingRoutes } from '../session/registerSessionListingRoutes';
import { registerSessionOrganizationRoutes } from '../session/registerSessionOrganizationRoutes';
import { featuresRoutes } from '../features/featuresRoutes';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { verifyExternalActionDomainExecutionRequest } from '@/app/auth/externalActionExecutionAuthorization';
import { createActionSettingsProvider } from '../../../../../../cli/src/settings/actionsSettingsProvider';
import { createActionToolExecutorBridge } from '../../../../../../cli/src/agent/tools/happierTools/createActionToolExecutorBridge';
import { createCliActionExecutorFromCredentials } from '../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createDaemonSessionAccountActionExecutor } from '../../../../../../cli/src/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { createExternalActionAuthorizedRequestHeaders, prepareExternalActionRequesterAccountAuthorization } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import type { AgentRuntimeDaemonServiceRequestV1 } from '../../../../../../cli/src/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';

type Operation = Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }>;
const operation: Operation = {
    kind: 'action.execute', requestId: 'request-1', actionId: 'session.organization.pin.set', input: {},
    witness: { turnId: 'turn-1', inputId: 'input-1', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 2,
        agentStartCaller: { kind: 'session', sessionId: 'replaced-by-caller', starterDepth: 1, turnDepth: 2 } },
};

describe('Agent personal Session pin composition', () => {
    it('pins the current Bot through the real Agent executor and signed Home HTTP owners', async () => {
        const harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-agent-pin-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        enableErrorHandlers(app);
        let publisherCurrent = true;
        try {
            const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
            const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(39));
            const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
                metadata: encodePlainMachineStoredContent({ host: 'pin-host', platform: 'linux', happyCliVersion: 'test' }),
                metadataVersion: 1, daemonStateVersion: 0, installationId: crypto.randomUUID(),
                installationPublicKey: keys.publicKey, dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
            const caller = await db.session.create({ data: { accountId: account.id, tag: crypto.randomUUID(),
                metadata: JSON.stringify({ bot: { kind: 'bot' } }), encryptionMode: 'plain', active: true, lastActiveAt: new Date() } });
            const bot = caller;
            await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: caller.id, data: 'source' } });
            const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
            const homeId = await getOrCreateServerIdentityId();
            const profileId = 'pin-local-profile';
            app.decorate('resolveCurrentSessionMachine', async () => publisherCurrent ? machine.id : null);
            // Socket publisher discovery is the only external runtime boundary. Home
            // issuance, authentication, access, currentness and pin persistence stay real.
            enableAuthentication(app);
            registerExternalActionRoutes(app, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
            registerAccountEncryptionRoutes(app);
            registerAccountSettingsRoutes(app);
            registerSessionListingRoutes(app);
            registerSessionOrganizationRoutes(app);
            featuresRoutes(app);
            const serverHttpBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
            const credentials = { token, encryption: null };
            const settings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1, actions: {
                'session.organization.pin.set': { approvalRequiredSurfaces: [] },
            } } });
            const settingsProvider = createActionSettingsProvider({ accountSettings: settings });
            const target = { kind: 'machine' as const, machineId: machine.id };
            let issued: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | null = null;
            const execute = createDaemonSessionAccountActionExecutor({ serverId: profileId, serverHttpBaseUrl, token,
                machineId: machine.id,
                prepareExternalActionAuthorization: async admission => {
                    const authorization = await prepareExternalActionRequesterAccountAuthorization({
                        actionId: admission.operation.actionId, input: admission.operation.input, requestId: admission.operation.requestId,
                        target, machineId: machine.id, sourceMachineId: machine.id, accountId: account.id,
                        accountEncryptionMode: 'plain', tokenEpochHint: account.tokenEpoch, token, serverId: profileId,
                        serverIdentityId: homeId, serverHttpBaseUrl, installationId: machine.installationId!, privateKey: keys.secretKey,
                        sessionActionOrigin: admission.sessionActionOrigin, isCurrent: admission.isCallerCurrent });
                    issued = authorization ?? null;
                    return authorization ? { authorization, target } : null;
                },
                createExecutor: getCurrentTurnWorkDepth => createCliActionExecutorFromCredentials({ credentials,
                    machineId: machine.id, serverId: profileId, serverApiUrl: serverHttpBaseUrl, serverIdentityId: homeId,
                    externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: machine.installationId!,
                    getCurrentTurnWorkDepth, actionsSettingsProvider: settingsProvider, pluginActionExecutionOwner: 'current_process' }),
            });
            const witness = { ...operation.witness, callerPermissionMode: 'yolo' as const,
                causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const },
                agentStartCaller: { kind: 'session' as const, sessionId: caller.id, starterDepth: 1, turnDepth: 2 } };
            const bridge = createActionToolExecutorBridge({ surface: 'agent', executor: {
                execute: (actionId, input) => execute({ ...operation, actionId, input, witness }, {
                    sessionId: caller.id, isCurrent: async () => true }),
            } });
            for (const serverId of [homeId, profileId, undefined]) {
                const result = await bridge.executeActionByToolName('action_execute', { actionId: 'session.organization.pin.set',
                    input: { sessionId: bot.id, surface: 'rail', pinned: true, ...(serverId ? { serverId } : {}) } }, caller.id);
                expect(result, result.ok ? undefined : JSON.stringify({ errorCode: result.errorCode, error: result.error, details: result.details }))
                    .toMatchObject({ ok: true, result: { pin: { sessionId: bot.id, railPinned: true, listPinned: false } } });
                if (result.ok) expect(SetSessionPinResponseSchema.parse(result.result).pin?.sessionId).toBe(bot.id);
            }
            expect(await db.sessionPin.findUnique({ where: { accountId_sessionId: { accountId: account.id, sessionId: bot.id } } }))
                .toMatchObject({ railPinned: true, listPinned: false });
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued);
            const signedRequest = async (method: string, path: string, body?: unknown) => await fetch(`${serverHttpBaseUrl}${path}`, {
                method, headers: { ...createExternalActionAuthorizedRequestHeaders({ authorization,
                    effectActionId: 'session.organization.pin.set', target, installationId: machine.installationId!,
                    method, path, ...(body === undefined ? {} : { body }), privateKey: keys.secretKey }),
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            for (const path of ['/v1/account/encryption/currentness?accountId=other', '/v1/account/encryption',
                '/v2/account/settings', `/v2/sessions/${bot.id}?extra=1`]) {
                expect((await signedRequest('GET', path)).status, path).toBe(401);
            }
            // Fetch normalizes dot segments before dispatch. Feed the real
            // issuer's proof to the strict consumer to attack raw path aliases.
            for (const [path, body] of [
                ['/v1/account/encryption/./currentness', undefined],
                [`/v2/sessions/${bot.id}/../${bot.id}`, undefined],
                [`http://home.invalid/v2/sessions/${bot.id}`, undefined],
                ['/v1/account/encryption/currentness', {}],
            ] as const) {
                expect(await verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token,
                    effectActionId: 'session.organization.pin.set', encodedTarget: encodeExternalActionResolvedTargetV1(target),
                    method: 'GET', path, body, resolveCurrentSessionMachine: async () => publisherCurrent ? machine.id : null,
                    machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                        effectActionId: 'session.organization.pin.set', target, installationId: machine.installationId!,
                        requestId: authorization.binding.requestId, method: 'GET', path, body, privateKey: keys.secretKey }),
                }), path).toBeNull();
            }
            expect((await signedRequest('PUT', `/v2/session-organization/pins/${bot.id}?extra=1`, { pinned: true, surface: 'rail' })).status).toBe(401);
            expect((await signedRequest('PUT', `/v2/session-organization/pins/${bot.id}`, { pinned: true, surface: 'rail', unrelated: true })).status).toBe(400);
            const otherAccount = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
            const foreign = await db.session.create({ data: { accountId: otherAccount.id, tag: crypto.randomUUID(),
                metadata: JSON.stringify({ bot: { kind: 'bot' } }), encryptionMode: 'plain' } });
            expect((await signedRequest('GET', `/v2/sessions/${foreign.id}`)).status).toBe(404);
            expect((await signedRequest('PUT', `/v2/session-organization/pins/${foreign.id}`, { pinned: true })).status).toBe(404);
            expect(await db.sessionPin.findUnique({ where: { accountId_sessionId: { accountId: account.id, sessionId: foreign.id } } })).toBeNull();
            const otherOwned = await db.session.create({ data: { accountId: account.id, tag: crypto.randomUUID(),
                metadata: '{}', encryptionMode: 'plain' } });
            const otherPin = await signedRequest('PUT', `/v2/session-organization/pins/${otherOwned.id}`, { pinned: true });
            expect(otherPin.status).toBe(200);
            expect(SetSessionPinResponseSchema.parse(await otherPin.json()).pin).toMatchObject({ sessionId: otherOwned.id, listPinned: true });
            await db.session.update({ where: { id: bot.id }, data: { metadata: '{}' } });
            await expect(bridge.executeActionByToolName('action_execute', { actionId: 'session.organization.pin.set', input: {
                sessionId: bot.id, surface: 'rail', pinned: true,
            } }, caller.id)).resolves.toMatchObject({ ok: false, errorCode: 'session_not_bot' });
            await expect(bridge.executeActionByToolName('action_execute', { actionId: 'session.organization.pin.set', input: {
                sessionId: bot.id, pinned: true,
            } }, caller.id)).resolves.toMatchObject({ ok: true, result: { pin: { listPinned: true, railPinned: true } } });
            await expect(bridge.executeActionByToolName('action_execute', { actionId: 'session.organization.pin.set', input: {
                sessionId: bot.id, surface: 'rail', pinned: false,
            } }, caller.id)).resolves.toMatchObject({ ok: true, result: { pin: { listPinned: true, railPinned: false } } });
            await expect(bridge.executeActionByToolName('action_execute', { actionId: 'session.organization.pin.set', input: {
                sessionId: bot.id, surface: 'rail', pinned: false, serverId: 'srv_other-home',
            } }, caller.id)).resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
            publisherCurrent = false;
            expect((await signedRequest('GET', '/v1/account/encryption/currentness')).status).toBe(401);
            await expect(bridge.executeActionByToolName('action_execute', { actionId: 'session.organization.pin.set', input: {
                sessionId: bot.id, surface: 'rail', pinned: false,
            } }, caller.id)).resolves.toMatchObject({ ok: false });
            expect(await db.sessionPin.findUnique({ where: { accountId_sessionId: { accountId: account.id, sessionId: bot.id } } }))
                .toMatchObject({ listPinned: true, railPinned: false });
        } finally { await app.close(); await harness.close(); }
    }, 300_000);

});
