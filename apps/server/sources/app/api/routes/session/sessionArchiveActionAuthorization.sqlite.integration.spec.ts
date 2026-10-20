import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import {
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1,
    computeExternalActionRequestEnvelopeDigestV1, encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { registerSessionArchiveRoutes } from './registerSessionArchiveRoutes';
import { registerSessionPatchRoute } from './registerSessionPatchRoute';
import { auth } from '@/app/auth/auth';
import { verifyExternalActionDomainExecutionRequest } from '@/app/auth/externalActionExecutionAuthorization';
import { SessionMetadataTuplePatchV1Schema, createSessionOwnerMetadataV1,
    projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { writeSessionExplicitStopV1ToMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilityHttpHeadersV1 } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { setSessionManager } from '@/app/session/follow/sessionManagerService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { initializeSessionSystemRecordsProtocolV1Activation, resetSessionSystemRecordsProtocolV1ActivationForTests } from '@/app/session/systemRecords/sessionSystemRecordProtocolContract';

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-session-archive-action-',
        initAuth: true, initEncrypt: true, initFiles: true,
        env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    await expect(initializeSessionSystemRecordsProtocolV1Activation(db)).resolves.toBe(true);
}, 300_000);
afterEach(async () => {
    await db.sessionFollowEdge.deleteMany();
    await db.accessKey.deleteMany();
    await db.machine.deleteMany();
    await db.session.deleteMany();
    await db.account.deleteMany();
});

it.each([
    ['session.open', 'manager'], ['session.stop', 'manager'],
    ['session.open', 'person'], ['session.stop', 'person'],
] as const)('admits only current manager metadata phases under the original signed %s root (%s)', async (actionId, actor) => {
    const fixture = await createFixture();
    const caller = await db.session.create({ data: { accountId: fixture.account.id,
        tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
    const child = await db.session.create({ data: { accountId: fixture.account.id,
        tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}', active: false } });
    await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
        sessionId: caller.id, data: 'installed-resume-source' } });
    const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
    expect(await setSessionManager({ accountId: fixture.account.id, sessionId: child.id,
        managerSessionId: caller.id, expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
    let publisher: string | null = fixture.machine.id;
    const { app } = await createApp(async () => publisher);
    try {
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: caller.id, starterDepth: 0, turnDepth: 0 },
            sourceTurnId: 'resume-turn', requestId: crypto.randomUUID(), callerPermissionMode: 'default' });
        const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const envelope = { v: 1 as const, requestId: origin.requestId,
            target: { kind: 'machine' as const, machineId: fixture.machine.id },
            input: { sessionId: child.id, ...(actionId === 'session.open' ? { intent: 'resume' } : {}) } };
        const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...source,
                externalActionOrigin: { homeId, actionId, requestId: origin.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id,
                envelope, ...(actor === 'manager' ? { sessionActionOrigin: origin, sessionActionSource: source, installationProof } : {}) } });
        expect(minted.statusCode, minted.body).toBe(200);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
        const metadata = writeSessionExplicitStopV1ToMetadata({}, { v: 1, cause: 'explicit_stop',
            requestId: origin.requestId, requestedAtMs: 1, ...(actor === 'manager' ? { managerSessionId: caller.id } : {}) });
        const held = createSessionOwnerMetadataV1({ metadata });
        if (!held.ok) throw new Error('Canonical Stop producer must project to owner metadata');
        const previousOwner = { t: 'plain' as const, v: actionId === 'session.open' ? held.ownerMetadata : { v: 1 as const } };
        const nextOwner = { t: 'plain' as const, v: actionId === 'session.stop' ? held.ownerMetadata : { v: 1 as const } };
        const patch = SessionMetadataTuplePatchV1Schema.parse({ mode: 'owner', metadataLayoutVersion: 1,
            expectedOwnerMetadata: previousOwner,
            sharedMetadata: { ciphertext: JSON.stringify(projectSessionSharedMetadataV1({ metadata })), expectedVersion: 0 },
            ownerMetadata: nextOwner, agentState: { ciphertext: null, expectedVersion: 0 } });
        if (patch.mode !== 'owner') throw new Error('Expected the native owner metadata tuple');
        const verify = (method: string, body: unknown, sessionId = child.id) => {
            const path = `/v2/sessions/${sessionId}`;
            return verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token,
                encodedTarget: encodeExternalActionResolvedTargetV1(authorization.binding.target), effectActionId: actionId,
                method, path, body, sessionRouteTarget: { kind: 'session', sessionId },
                resolveCurrentSessionMachine: async () => publisher,
                machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target: authorization.binding.target, installationId: fixture.machine.installationId!,
                    requestId: authorization.binding.requestId, method, path, body, privateKey: fixture.keyPair.secretKey }),
            });
        };
        expect(await verify('GET', undefined)).not.toBeNull();
        expect(await verify('PATCH', patch)).not.toBeNull();
        await db.session.update({ where: { id: child.id }, data: { metadataLayoutVersion: 1,
            metadata: patch.sharedMetadata.ciphertext, ownerMetadata: JSON.stringify(previousOwner),
            metadataVersion: 0, agentStateVersion: 0 } });
        const path = `/v2/sessions/${child.id}`;
        const applied = await app.inject({ method: 'PATCH', url: path, payload: patch, headers: {
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId: actionId, target: authorization.binding.target, installationId: fixture.machine.installationId!,
                requestId: authorization.binding.requestId, method: 'PATCH', path, body: patch, privateKey: fixture.keyPair.secretKey }),
        } });
        expect(applied.statusCode, applied.body).toBe(200);
        const persisted = await db.session.findUniqueOrThrow({ where: { id: child.id } });
        expect(JSON.parse(persisted.ownerMetadata!)).toEqual(nextOwner);
        expect(await verify('PATCH', { mode: 'shared_editor', metadataLayoutVersion: 1,
            sharedMetadata: patch.sharedMetadata })).toBeNull();
        const unrelated = await db.session.create({ data: { accountId: fixture.account.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        if (actor === 'manager') expect(await verify('PATCH', patch, unrelated.id)).toBeNull();
        const otherAccount = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const sharedChild = await db.session.create({ data: { accountId: otherAccount.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}', active: false } });
        await db.sessionShare.create({ data: { sessionId: sharedChild.id, sharedByUserId: otherAccount.id,
            sharedWithUserId: fixture.account.id, accessLevel: 'edit' } });
        expect(await setSessionManager({ accountId: fixture.account.id, sessionId: sharedChild.id,
            managerSessionId: caller.id, expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
        expect(await verify('PATCH', patch, sharedChild.id)).toBeNull();
        expect(await setSessionManager({ accountId: fixture.account.id, sessionId: child.id,
            managerSessionId: null, expectedManagerSessionId: caller.id, authentication })).toMatchObject({ ok: true });
        expect((await verify('PATCH', patch)) === null).toBe(actor === 'manager');
        publisher = null;
        if (actor === 'manager') expect(await verify('GET', undefined)).toBeNull();
        await db.machine.update({ where: { id: fixture.machine.id }, data: { installationId: crypto.randomUUID() } });
        expect(await verify('GET', undefined)).toBeNull();
    } finally { await app.close(); }
});
afterAll(async () => {
    resetSessionSystemRecordsProtocolV1ActivationForTests();
    await harness?.close();
});

async function createFixture() {
    const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
    const keyPair = nacl.sign.keyPair();
    const machine = await db.machine.create({ data: {
        id: crypto.randomUUID(), accountId: account.id,
        metadata: encodePlainMachineStoredContent({}), metadataVersion: 1,
        dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
        installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keyPair.publicKey),
    } });
    return { account, machine, keyPair };
}

async function createApp(resolveCurrentSessionMachine: () => Promise<string | null>) {
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    app.decorate('resolveCurrentSessionMachine', resolveCurrentSessionMachine);
    registerExternalActionRoutes(app, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
    registerSessionArchiveRoutes(app);
    registerSessionPatchRoute(app);
    await app.ready();
    return { app };
}

it.each(['session.archive', 'session.unarchive'] as const)('admits installed lifecycle signatures through the production archive route: %s', async actionId => {
    const fixture = await createFixture();
    const caller = await db.session.create({ data: { accountId: fixture.account.id,
        tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
    const child = await db.session.create({ data: { accountId: fixture.account.id,
        tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}', active: false,
        archivedAt: actionId === 'session.unarchive' ? new Date(123) : null } });
    await db.accessKey.create({ data: { accountId: fixture.account.id, machineId: fixture.machine.id,
        sessionId: caller.id, data: 'installed-lifecycle-source' } });
    let publisher: string | null = fixture.machine.id;
    const { app } = await createApp(async () => publisher);
    try {
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const origin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: caller.id, starterDepth: 0, turnDepth: 0 },
            sourceTurnId: 'lifecycle-turn', requestId: crypto.randomUUID(), callerPermissionMode: 'default' });
        const source = { machineId: fixture.machine.id, installationId: fixture.machine.installationId! };
        const envelope = { v: 1 as const, requestId: origin.requestId,
            target: { kind: 'machine' as const, machineId: fixture.machine.id }, input: { sessionId: child.id } };
        const installationProof = signMachineInstallationProof({ privateKey: fixture.keyPair.secretKey,
            payload: { version: 1, accountId: fixture.account.id, ...source,
                externalActionOrigin: { homeId, actionId, requestId: origin.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
        const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: fixture.machine.id,
                envelope, sessionActionOrigin: origin, sessionActionSource: source, installationProof } });
        expect(minted.statusCode, minted.body).toBe(200);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
        const invoke = (operation: 'archive' | 'unarchive', sessionId = child.id) => {
            const path = `/v2/sessions/${sessionId}/${operation}`;
            return app.inject({ method: 'POST', url: path, payload: {}, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target: authorization.binding.target, installationId: fixture.machine.installationId!,
                    requestId: authorization.binding.requestId, method: 'POST', path, body: {}, privateKey: fixture.keyPair.secretKey }),
            } });
        };
        const operation = actionId === 'session.archive' ? 'archive' : 'unarchive';
        const result = await invoke(operation);
        expect(result.statusCode, result.body).toBe(200);
        const persisted = await db.session.findUniqueOrThrow({ where: { id: child.id } });
        expect(persisted.archivedAt === null).toBe(actionId === 'session.unarchive');
        expect((await invoke(operation === 'archive' ? 'unarchive' : 'archive')).statusCode).not.toBe(200);
        const outsider = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const outsiderSession = await db.session.create({ data: { accountId: outsider.id,
            tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}', active: false } });
        expect((await invoke(operation, outsiderSession.id)).statusCode).toBe(403);
        if (actionId === 'session.archive') {
            await db.session.update({ where: { id: child.id }, data: { active: true, archivedAt: null } });
            expect((await invoke(operation)).statusCode).toBe(409);
        }
        publisher = null;
        expect((await invoke(operation)).statusCode).toBe(401);
    } finally { await app.close(); }
});
