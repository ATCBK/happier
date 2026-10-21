import fastify, { type FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64, type JsonValue } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import {
    bindExternalActionExecutionAuthorizationHttpPathV1,
    bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
    encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1,
    computeExternalActionRequestEnvelopeDigestV1,
    ExternalActionExecutionAuthorizationV1Schema,
    externalActionExecutionAuthorizationRequestSchemaForActionV1,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol/actions';
import { signMachineInstallationProof, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { signExternalActionApprovalInputV1, verifyExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { auth } from '@/app/auth/auth';
import { verifyCurrentExternalActionPrincipal, verifyExternalActionExecutionAuthorizationCurrentness,
    verifyExternalActionDomainExecutionRequest } from '@/app/auth/externalActionExecutionAuthorization';
import { hasCurrentSessionActionRpcSourceBinding } from '@/app/api/socket/sessionScopedBinding';
import { createAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { enableAuthentication } from '../../utils/enableAuthentication';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { installedSessionExternalActionStorage as storage } from '../../testkit/installedSessionExternalActionStorage';

// Database I/O is the only substitute: installation signatures, Machine and
// Session admission, credential policy, Home minting and currentness stay real.
vi.mock('@/storage/db', async importOriginal => ({
    ...await importOriginal<typeof import('@/storage/db')>(),
    db: (await import('../../testkit/installedSessionExternalActionStorage')).installedSessionExternalActionStorage.db,
}));

const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));

function proposal(actionId: string, actionInput?: JsonValue) {
    const origin = { v: 1 as const, caller: { kind: 'session' as const, sessionId: 'session', starterDepth: 0, turnDepth: 0 },
        sourceTurnId: 'turn', callerPermissionMode: null, requestId: `proposal-${actionId}` };
    const source = { machineId: 'machine', installationId: 'installation' };
    const input: JsonValue = actionInput ?? (actionId === 'teams.list' ? { v: 1, scope: 'member', archived: 'active' }
        : actionId === 'teams.invitations.create' ? { v: 1, teamId: 'team', role: 'member',
            historyAccess: 'from_membership', recipientEmail: null, requestKey: 'create-request' }
        : { v: 1, teamId: 'team', invitationId: 'invitation', recipientEmail: null, requestKey: 'reissue-request' });
    const envelope = { v: 1 as const, requestId: origin.requestId, target: { kind: 'machine' as const, machineId: 'machine' }, input };
    const installationProof = signMachineInstallationProof({ privateKey: installation.secretKey,
        payload: { version: 1, accountId: 'account', ...source, externalActionOrigin: {
            homeId: 'srv_proposal_admission', actionId, requestId: origin.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } });
    return { v: 1 as const, machineId: 'machine', envelope, sessionActionOrigin: origin, sessionActionSource: source, installationProof };
}

function createApp(kind: 'account' | 'terminal') {
    const app = createAuthenticatedTestApp();
    app.addHook('preHandler', async (request: FastifyRequest) => {
        request.authTokenLegacy = false;
        request.authTokenEpoch = 1;
    });
    app.decorate('resolveCurrentSessionMachine', async () => storage.state.bound ? 'machine' : null);
    const dispatch = vi.fn(async () => { throw new Error('Minting must not execute an Action'); });
    registerExternalActionRoutes(app, { dispatch });
    const mint = (actionId: string, body: unknown = proposal(actionId)) => app.inject({ method: 'POST',
        url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
        headers: { 'x-test-user-id': 'account', 'x-test-auth-token-kind': kind }, payload: body });
    return { app, mint, dispatch };
}

function signedRequestProof(authorization: ExternalActionExecutionAuthorizationV1, path: string, body: unknown,
    effectActionId = authorization.binding.actionId, method = 'POST') {
    const request = { authorizationToken: authorization.token, effectActionId,
        target: authorization.binding.target, installationId: authorization.binding.installationId,
        requestId: authorization.binding.requestId, method, path, body };
    return { authorizationToken: request.authorizationToken, effectActionId: request.effectActionId,
        encodedTarget: encodeExternalActionResolvedTargetV1(request.target), method: request.method, path, body,
        machineSignature: signExternalActionMachineRequestV1({ ...request, privateKey: installation.secretKey }),
        resolveCurrentSessionMachine: async () => storage.state.bound ? 'machine' : null };
}

function verifyProposalCurrentness(authorization: ExternalActionExecutionAuthorizationV1) {
    return verifyExternalActionExecutionAuthorizationCurrentness({
        ...signedRequestProof(authorization,
            bindExternalActionExecutionAuthorizationVerifyHttpPathV1(authorization.binding.actionId), { v: 1 }),
        outerActionId: authorization.binding.actionId,
    });
}

describe('installed Session proposal admission at the Home mint route', () => {
    it.each(['usage.recap.compose', 'usage.recap.export', 'usage.recap.deliver'])('binds %s public-source reads to the captured Account without a private-read grant', async actionId => {
        const { app, mint } = createApp('account');
        try {
            const input = { source: { kind: 'public_profile' }, ...(actionId.endsWith('.deliver') ? { intent: 'share' } : {}) };
            const response = await mint(actionId, proposal(actionId, input));
            expect(response.statusCode, response.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            const verify = (path: string, effect = actionId, method = 'GET', body?: unknown) =>
                verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, path, body, effect, method));
            expect(Boolean(await verify('/v1/account/public-profile/view'))).toBe(true);
            for (const path of ['/v1/account/public-profile/view?accountId=other-account', '/v1/account/public-profile', '/v1/usage/query']) {
                expect(await verify(path)).toBeNull();
            }
            expect(await verify('/v1/account/public-profile/view', 'usage.query')).toBeNull();
            expect(await verify('/v1/account/public-profile/view', actionId, 'POST', {})).toBeNull();
            storage.state.bound = false;
            expect(await verify('/v1/account/public-profile/view')).toBeNull();
        } finally { await app.close(); }
    });
    beforeAll(async () => {
        vi.stubEnv('HANDY_MASTER_SECRET', 'proposal-admission-test-secret');
        vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
        vi.stubEnv('AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS', '0');
        await auth.init();
    });
    afterAll(() => vi.unstubAllEnvs());
    beforeEach(() => {
        storage.account.tokenEpoch = 1;
        storage.otherAccount.tokenEpoch = 1;
        storage.state.bound = true;
        storage.state.publisherBound = true;
        storage.state.revokedAt = null;
        storage.state.publicKey = new Uint8Array(installation.publicKey);
        storage.state.metadata = encodePlainMachineStoredContent({});
        storage.state.dataEncryptionKey = MACHINE_PLAIN_DATA_KEY_MARKER;
    });

    it.each(['account', 'terminal'] as const)('admits only real signed predecessor %s installed-Session proposals', async kind => {
        storage.account.tokenEpoch = 0;
        storage.otherAccount.tokenEpoch = 0;
        // Exact ../0.2 createToken(accountId, extras?) payload and privacy-kit
        // signer: no epoch and no provenance marker are fabricated or upgraded.
        const generator = await privacyKit.createPersistentTokenGenerator({ service: 'handy', seed: 'proposal-admission-test-secret' });
        const token = await generator.new({ user: 'account', ...(kind === 'terminal' ? { extras: { session: 'paired-request' } } : {}) });
        const decoded = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
        expect(decoded).not.toHaveProperty('tokenEpoch');
        expect(decoded).not.toHaveProperty('provenance');
        expect(await auth.verifyTokenForRoute(token)).toMatchObject({ userId: 'account',
            tokenEpoch: 0, authTokenKind: kind, legacy: true });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        app.decorate('resolveCurrentSessionMachine', async (input: { accountId: string; sessionId: string }) =>
            storage.state.publisherBound && input.accountId === 'account' && input.sessionId === 'session' ? 'machine' : null);
        const dispatch = vi.fn(async () => { throw new Error('Minting must not execute an Action'); });
        registerExternalActionRoutes(app, { dispatch });
        const actionId = 'teams.list';
        const body = proposal(actionId);
        const signed = (candidate: typeof body, accountId = 'account') => ({ ...candidate,
            installationProof: signMachineInstallationProof({ privateKey: installation.secretKey,
                payload: { version: 1, accountId, ...candidate.sessionActionSource, externalActionOrigin: {
                    homeId: 'srv_proposal_admission', actionId, requestId: candidate.envelope.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(candidate.envelope), origin: candidate.sessionActionOrigin } } }) });
        const mint = (payload: unknown, credential = token) => app.inject({ method: 'POST',
            url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId), headers: { authorization: `Bearer ${credential}` }, payload });
        try {
            const accepted = await mint(body);
            expect(accepted.statusCode, accepted.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(accepted.json());
            if (!('authentication' in authorization.binding)) throw new Error('Expected original installed-Session authentication');
            expect(authorization.binding.authentication).toMatchObject({ kind, tokenEpoch: 0 });
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({ authority: 'account_automation' });
            expect(Boolean(await verifyProposalCurrentness(authorization))).toBe(true);
            expect(await verifyExternalActionExecutionAuthorizationCurrentness({
                ...signedRequestProof(authorization,
                    bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId), { v: 1 }),
                outerActionId: actionId, machineSignature: '',
            })).toBeNull();
            const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                createdBy: { surface: 'agent', sessionId: 'session' }, requestedSurface: 'agent', actionId,
                actionArgs: body.envelope.input, summary: 'Read Teams', executionOriginV1: {
                    v: 1, authority: 'account_automation', surface: 'agent', caller: body.sessionActionOrigin.caller,
                    serverId: 'profile', serverIdentityId: authorization.binding.serverIdentityId, accountId: 'account',
                    sessionId: 'session', machineId: 'machine', actionId, requestId: body.envelope.requestId,
                    callerPermissionMode: null,
                    sessionInputSource: { sourceSessionId: 'session', sourceTurnId: 'turn', via: 'action' },
                    target: body.envelope.target, externalActionExecutionAuthorization: authorization,
                    externalActionInputSignature: signExternalActionApprovalInputV1({ authorizationToken: authorization.token,
                        actionId, input: body.envelope.input, target: body.envelope.target, privateKey: installation.secretKey }),
                } });
            // The authenticated Artifact dependency is the I/O boundary. Home
            // minting, signature codecs and the public Action executor stay real.
            const publicReader = createActionExecutor({ approvalsGet: async () => approval } as unknown as ActionExecutorDeps);
            const observed = await publicReader.execute('approval.request.get', { artifactId: 'minted-approval' }, { surface: 'cli' });
            expect(observed).toMatchObject({ ok: true, result: { request: { actionId, status: 'open' } } });
            expect(JSON.stringify(observed).includes(authorization.token)).toBe(false);
            expect(JSON.stringify(observed)).not.toContain('externalActionInputSignature');
            for (const invalid of [
                { ...body, installationProof: undefined },
                { ...body, sessionActionSource: undefined },
                { ...body, sessionActionOrigin: undefined },
                { ...body, sessionActionOrigin: { ...body.sessionActionOrigin, caller: { ...body.sessionActionOrigin.caller, sessionId: 'foreign-session' } } },
                { ...body, sessionActionSource: { ...body.sessionActionSource, machineId: 'foreign-machine' } },
                { ...body, sessionActionSource: { ...body.sessionActionSource, installationId: 'foreign-installation' } },
                { ...body, sessionActionOrigin: { ...body.sessionActionOrigin, sourceTurnId: 'forged' } },
                { v: 1, machineId: body.machineId, envelope: body.envelope },
            ]) expect((await mint(invalid)).statusCode).toBe(401);
            // Valid installation signatures over wrong tuples still fail the
            // real Session/access/install binding owner, not only the codec.
            for (const invalid of [
                { ...body, sessionActionOrigin: { ...body.sessionActionOrigin, caller: { ...body.sessionActionOrigin.caller, sessionId: 'foreign-session' } } },
                { ...body, sessionActionSource: { ...body.sessionActionSource, machineId: 'foreign-machine' } },
                { ...body, sessionActionSource: { ...body.sessionActionSource, installationId: 'foreign-installation' } },
            ]) expect((await mint(signed(invalid))).statusCode).toBe(401);
            const foreignToken = await generator.new({ user: 'other-account', ...(kind === 'terminal' ? { extras: { session: 'paired-request' } } : {}) });
            expect((await mint(body, foreignToken)).statusCode).toBe(401);
            expect((await mint(signed(body, 'other-account'), foreignToken)).statusCode).toBe(401);
            const tampered = token.split('.');
            tampered[1] = Buffer.from(JSON.stringify({ ...decoded, sub: 'other-account' })).toString('base64url');
            expect((await mint(body, tampered.join('.'))).statusCode).toBe(401);
            storage.state.homeId = 'srv_other_home';
            expect((await mint(body)).statusCode).toBe(401);
            storage.state.homeId = 'srv_proposal_admission';
            storage.state.bound = false;
            expect((await mint(body)).statusCode).toBe(401);
            storage.state.bound = true;
            storage.state.publisherBound = false;
            expect((await mint(body)).statusCode).toBe(401);
            storage.state.publisherBound = true;
            storage.state.publicKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(30)).publicKey;
            expect((await mint(body)).statusCode).toBe(401);
            storage.state.publicKey = installation.publicKey;
            storage.state.revokedAt = new Date();
            expect((await mint(body)).statusCode).toBe(401);
            expect(await verifyProposalCurrentness(authorization)).toBeNull();
            storage.state.revokedAt = null;
            storage.account.tokenEpoch = 1;
            expect((await mint(body)).statusCode).toBe(401);
            expect(await verifyProposalCurrentness(authorization)).toBeNull();
            expect(dispatch).not.toHaveBeenCalled();
        } finally {
            storage.state.homeId = 'srv_proposal_admission';
            await app.close();
        }
    });

    it.each(['account', 'terminal'] as const)('admits invitation proposals with %s credentials without execution authority', async kind => {
        const { app, mint, dispatch } = createApp(kind);
        try {
            for (const actionId of ['teams.invitations.create', 'teams.invitations.reissue']) {
                const body = proposal(actionId);
                expect(externalActionExecutionAuthorizationRequestSchemaForActionV1(actionId).safeParse(body).success).toBe(true);
                const response = await mint(actionId, body);
                expect(response.statusCode, response.statusCode === 200 ? undefined : response.json().error).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
                expect(authorization.binding).toMatchObject({ actionId, sessionActionOrigin: body.sessionActionOrigin,
                    sessionActionSource: body.sessionActionSource, authentication: { kind, tokenEpoch: 1 } });
                expect(await auth.verifyExternalActionExecutionAuthorization(authorization.token)).toEqual(authorization.binding);
                expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({
                    authority: 'account_automation', sessionActionOrigin: body.sessionActionOrigin });
                expect(Boolean(await verifyProposalCurrentness(authorization))).toBe(true);
                const path = actionId === 'teams.invitations.create'
                    ? '/v1/teams/invitations/create' : '/v1/teams/invitations/reissue';
                expect(await verifyExternalActionDomainExecutionRequest(
                    signedRequestProof(authorization, path, body.envelope.input))).toBeNull();
                storage.state.bound = false;
                expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toBeNull();
                expect(await verifyProposalCurrentness(authorization)).toBeNull();
                storage.state.bound = true;
            }
            expect(dispatch).not.toHaveBeenCalled();
        } finally { await app.close(); }
    });

    it('rejects missing, forged and unbound invitation proposal sources', async () => {
        const { app, mint, dispatch } = createApp('terminal');
        const actionId = 'teams.invitations.create';
        const body = proposal(actionId);
        try {
            for (const invalid of [
                { ...body, installationProof: undefined },
                { ...body, sessionActionSource: undefined },
                { ...body, sessionActionOrigin: undefined },
                { ...body, sessionActionOrigin: { ...body.sessionActionOrigin, sourceTurnId: 'forged' } },
                { v: 1, machineId: body.machineId, envelope: body.envelope },
            ]) expect((await mint(actionId, invalid)).statusCode).toBe(401);
            storage.state.bound = false;
            expect((await mint(actionId, body)).statusCode).toBe(401);
            storage.state.bound = true;
            storage.state.revokedAt = new Date();
            expect((await mint(actionId, body)).statusCode).toBe(401);
            expect(dispatch).not.toHaveBeenCalled();
        } finally { await app.close(); }
    });

    it.each(['account', 'terminal'] as const)('retains Account-placed owner Session reads with %s credentials', async kind => {
        const { app, mint, dispatch } = createApp(kind);
        try {
            const body = proposal('teams.list');
            expect(externalActionExecutionAuthorizationRequestSchemaForActionV1('teams.list').safeParse(body).success).toBe(true);
            expect(verifyMachineInstallationProof({ publicKey: storage.state.publicKey, proof: body.installationProof,
                payload: { version: 1, accountId: 'account', ...body.sessionActionSource, externalActionOrigin: {
                    homeId: 'srv_proposal_admission', actionId: 'teams.list', requestId: body.envelope.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope), origin: body.sessionActionOrigin } } })).toBe(true);
            expect(await hasCurrentSessionActionRpcSourceBinding({ accountId: 'account', ...body.sessionActionSource,
                sourceSessionId: 'session', resolveCurrentSessionMachine: async () => 'machine' })).toBe(true);
            const response = await mint('teams.list');
            expect(response.statusCode).toBe(200);
            const authorization: ExternalActionExecutionAuthorizationV1 = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(await verifyCurrentExternalActionPrincipal(authorization.binding)).toMatchObject({ authority: 'account_automation' });
            const request = bindHomeDomainActionHttpRequestV1('teams.list', body.envelope.input);
            expect(Boolean(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, request.path, request.body)))).toBe(true);
            expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, '/v1/teams/archive', request.body))).toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, request.path, request.body, 'teams.archive'))).toBeNull();
            expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, request.path, request.body, 'teams.list', 'GET'))).toBeNull();
            expect(dispatch).not.toHaveBeenCalled();
        } finally { await app.close(); }
    });

    it.each(['account', 'terminal'] as const)('admits the installed Session Home runtime read with %s credentials', async kind => {
        const { app, mint } = createApp(kind);
        try {
            const body = proposal('home.runtime.get', { force: true });
            const response = await mint('home.runtime.get', body);
            expect(response.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(Boolean(await verifyProposalCurrentness(authorization))).toBe(true);
            storage.state.bound = false;
            expect((await mint('home.runtime.get', body)).statusCode).toBe(401);
        } finally { await app.close(); }
    });

    it('keeps a public self-name creator carrier as authoring provenance without granting the profile effect', async () => {
        const { app, mint, dispatch } = createApp('account');
        try {
            const input = { actionId: 'account.name.set', actionArgs: { name: 'Captain' },
                summary: 'Set my name', createdBy: { surface: 'agent' } };
            const response = await mint('approval.request.create', proposal('approval.request.create', input));
            expect(response.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(authorization.binding.actionId).toBe('approval.request.create');
            expect(Boolean(await verifyProposalCurrentness(authorization))).toBe(true);
            expect(await verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization,
                '/v1/account/profile', input.actionArgs, 'account.name.set'))).toBeNull();
            expect(dispatch).not.toHaveBeenCalled();
        } finally { await app.close(); }
    });

    it.each(['approval.request.create', 'memory.remember'] as const)(
        'admits only signed read-only Artifact exposure preparation for %s', async rootActionId => {
            const { app, mint } = createApp('account');
            const artifactId = '11111111-1111-4111-8111-111111111111';
            try {
                const actionArgs = { ref: { kind: 'doc' as const, artifactId },
                    expectedRevision: { headerVersion: 1, bodyVersion: 1 }, text: 'A reviewed memory fact' };
                const response = await mint(rootActionId, proposal(rootActionId, rootActionId === 'memory.remember' ? actionArgs : {
                    actionId: 'memory.remember', actionArgs,
                    summary: 'Remember a fact', createdBy: { surface: 'agent' },
                }));
                expect(response.statusCode).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
                const read = (path: string, effectActionId = 'artifact.access.grants.list', method = 'GET', body?: unknown) =>
                    verifyExternalActionDomainExecutionRequest(signedRequestProof(authorization, path, body, effectActionId, method));
                const grants = `/v1/artifacts/${artifactId}/access/grants`;
                const publications = `/v1/public-shares?subjectKind=artifact&subjectId=${artifactId}`;
                expect(await read(grants)).not.toBeNull();
                expect(await read(publications)).not.toBeNull();
                // Exposure inspection opens no content and grants no repair or mutation authority.
                for (const path of [`/v1/artifacts/${artifactId}`, '/v1/account/encryption/currentness',
                    `/v1/artifacts/${artifactId}/access/recipients`, `${grants}?other=1`, `${publications}&other=1`,
                    `${publications}&subjectId=other`, publications.replace('subjectKind=artifact', 'subjectKind=session')]) {
                    expect(await read(path)).toBeNull();
                }
                expect(await read(`/v1/artifacts/${artifactId}`, 'artifact.update', 'POST', {})).toBeNull();
                expect(await read(grants, 'artifact.access.grants.set', 'PUT', {})).toBeNull();
                expect(await read(`/v1/artifacts/${artifactId}/access/key-envelopes`, undefined, 'POST', {})).toBeNull();
                expect(await read(publications, undefined, 'POST', {})).toBeNull();
                storage.state.bound = false;
                expect(await read(grants)).toBeNull();
                expect(await read(publications)).toBeNull();
            } finally { await app.close(); }
        },
    );

    it('authenticates a declared parameterized GET without admitting another operation or caller query shape', async () => {
        const { app, mint } = createApp('terminal');
        const domain = fastify().withTypeProvider<ZodTypeProvider>();
        domain.decorate('resolveCurrentSessionMachine', async () => 'machine');
        enableAuthentication(domain);
        const path = '/v1/teams/team/directory-sources';
        domain.get('/v1/teams/:teamId/directory-sources', {
            preHandler: domain.authenticate,
            schema: { querystring: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false } },
        }, async request => ({ accountId: request.userId, authority: request.authAuthority }));
        try {
            const actionId = 'teams.directory.sources.list';
            const minted = await mint(actionId, proposal(actionId, { v: 1, teamId: 'team', limit: 25 }));
            expect(minted.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const read = (requestPath: string, effectActionId = actionId) => {
                const proof = signedRequestProof(authorization, requestPath, undefined, effectActionId, 'GET');
                return domain.inject({ method: 'GET', url: requestPath, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: proof.encodedTarget,
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: proof.machineSignature,
                } });
            };
            const accepted = await read(`${path}?limit=25`);
            expect(accepted.statusCode).toBe(200);
            expect(accepted.json()).toEqual({ accountId: 'account', authority: 'account_automation' });
            expect((await read(`${path}?limit=25`, 'teams.archive')).statusCode).toBe(401);
            expect((await read(`${path}?limit=25&view=census`)).statusCode).toBe(401);
        } finally { await domain.close(); await app.close(); }
    });

    it.each(['account', 'terminal'] as const)('admits only the Team export root\'s canonical usage read with %s credentials', async kind => {
        const { app, mint } = createApp(kind);
        const actionId = 'teams.credentials.usage.export';
        const query = { resourceId: 'resource', startMs: 0, endMs: 1000, granularity: 'day', costMode: 'auto' };
        try {
            const minted = await mint(actionId, proposal(actionId, { query, resourceName: 'Shared model' }));
            expect(minted.statusCode).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const read = bindHomeDomainActionHttpRequestV1('teams.credentials.usage.query', query);
            expect(Boolean(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, read.path, read.body, 'teams.credentials.usage.query')))).toBe(true);
            for (const proof of [
                signedRequestProof(authorization, '/v1/teams/archive', read.body, 'teams.credentials.usage.query'),
                signedRequestProof(authorization, read.path, read.body, 'teams.credentials.get'),
                signedRequestProof(authorization, read.path, read.body, 'teams.credentials.usage.query', 'GET'),
                signedRequestProof(authorization, read.path, { ...query, credential: 'not-a-query-field' }, 'teams.credentials.usage.query'),
            ]) expect(await verifyExternalActionDomainExecutionRequest(proof)).toBeNull();
            const otherRoot = await mint('teams.list');
            const other = ExternalActionExecutionAuthorizationV1Schema.parse(otherRoot.json());
            expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(other, read.path, read.body, 'teams.credentials.usage.query'))).toBeNull();
            storage.state.bound = false;
            expect(await verifyExternalActionDomainExecutionRequest(
                signedRequestProof(authorization, read.path, read.body, 'teams.credentials.usage.query'))).toBeNull();
        } finally { await app.close(); }
    });

    it.each(['teams.invitations.create', 'teams.invitations.reissue'] as const)(
        'executes admitted %s once after human approval with safe Agent results', async actionId => {
            const { app, mint } = createApp('terminal');
            const domain = fastify().withTypeProvider<ZodTypeProvider>();
            enableAuthentication(domain);
            try {
                const body = proposal(actionId);
                const minted = await mint(actionId, body);
                expect(minted.statusCode).toBe(200);
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
                const principal = await verifyCurrentExternalActionPrincipal(authorization.binding);
                expect(principal?.authority).toBe('account_automation');
                if (!principal || principal.authority !== 'account_automation') throw new Error('Expected the admitted automation principal');
                let stored: ApprovalRequest | null = null;
                const persisted: ApprovalRequest[] = [];
                const invitation = { id: 'invitation', teamId: 'team', state: 'active', role: 'member',
                    historyAccess: 'from_membership', recipientEmailMask: null, expiresAt: 2, createdAt: 1,
                    createdByAccountId: 'account', acceptedByAccountId: null, lastEmailDelivery: null };
                const bearer = 'human-custody-sentinel';
                const output = actionId === 'teams.invitations.create'
                    ? { invitation, joinUrl: `https://home.invalid/join/${bearer}` }
                    : { previous: { ...invitation, state: 'revoked' }, replacement: invitation,
                        joinUrl: `https://home.invalid/join/${bearer}` };
                let effects = 0;
                const path = actionId === 'teams.invitations.create'
                    ? '/v1/teams/invitations/create' : '/v1/teams/invitations/reissue';
                domain.post(path, { preHandler: domain.authenticate }, async (request, reply) => {
                    if (request.userId !== 'account' || request.authAuthority !== 'present_user') {
                        return reply.code(403).send({ error: 'present_user_required' });
                    }
                    expect(request.body).toEqual(body.envelope.input);
                    effects += 1;
                    return output;
                });
                const humanCredential = await auth.createToken('account', undefined, {
                    kind: 'account', authority: 'present_user',
                });
                // The proposal carrier remains automation authority and cannot perform the effect.
                expect(await verifyExternalActionDomainExecutionRequest(
                    signedRequestProof(authorization, path, body.envelope.input))).toBeNull();
                // Artifact persistence and the Home domain HTTP effect are
                // boundaries; the approval, signature and egress owners are real.
                const deps = {
                    homeDomainAction: async (args: Parameters<NonNullable<ActionExecutorDeps['homeDomainAction']>>[0]) => {
                        expect(args.context).toMatchObject({ surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
                        expect(args.context.externalActionExecutionAuthorization === undefined).toBe(true);
                        expect(args.context.externalActionCredential === undefined).toBe(true);
                        expect(args.context.rpcSessionAuthorization === undefined).toBe(true);
                        const response = await domain.inject({ method: 'POST', url: path,
                            headers: { authorization: `Bearer ${humanCredential}`, 'content-type': 'application/json' },
                            payload: JSON.stringify(args.input) });
                        expect(response.statusCode).toBe(200);
                        return response.json();
                    },
                    approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
                        stored = ApprovalRequestV2Schema.parse(request); persisted.push(stored);
                        return { artifactId: 'proposal-approval' };
                    },
                    approvalsGet: async () => stored,
                    approvalsUpdate: async ({ request }: { request: ApprovalRequest }) => {
                        if (!stored) throw new Error('Missing approval');
                        const transition = decideApprovalRequestTransition(stored, request);
                        if (!transition.ok) return transition;
                        stored = ApprovalRequestV2Schema.parse(request); persisted.push(stored);
                        return { ok: true as const };
                    },
                    isApprovalExecutionOriginCurrent: async ({ request }: Parameters<NonNullable<ActionExecutorDeps['isApprovalExecutionOriginCurrent']>>[0]) =>
                        request.v === 2 && Boolean(await verifyProposalCurrentness(authorization))
                        && verifyExternalActionApprovalInputV1({ authorizationToken: authorization.token,
                            actionId: request.actionId, input: request.actionArgs, target: authorization.binding.target,
                            signature: request.executionOriginV1.externalActionInputSignature!, publicKey: installation.publicKey }),
                    isActionApprovalRequired: () => false,
                };
                // Unused transport arms are absent from this boundary fixture.
                const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
                const context = { surface: 'agent' as const, authority: principal?.authority,
                    serverId: 'profile', serverIdentityId: 'srv_proposal_admission', runtimeAccountId: 'account',
                    actionRequestId: body.envelope.requestId, actionCaller: body.sessionActionOrigin.caller,
                    defaultSessionId: 'session', callerPermissionMode: null,
                    sessionInputSource: { sourceSessionId: 'session', sourceTurnId: 'turn', via: 'action' as const },
                    externalActionExecutionAuthorization: authorization, externalActionTarget: body.envelope.target,
                    signExternalActionApprovalInput: (args: Parameters<NonNullable<ActionExecutorContext['signExternalActionApprovalInput']>>[0]) =>
                        signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
                            actionId: args.actionId, input: args.input, target: args.target, privateKey: installation.secretKey }),
                };
                const pending = await executor.execute(actionId, body.envelope.input, context);
                expect(pending, pending.ok ? undefined : `${pending.errorCode}: ${pending.error}`).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                expect(effects).toBe(0);
                expect(JSON.stringify(pending).includes(bearer)).toBe(false);
                const request = ApprovalRequestV2Schema.parse(stored);
                expect(request.executionOriginV1.authority).toBe('account_automation');
                expect(verifyExternalActionApprovalInputV1({ authorizationToken: authorization.token,
                    actionId, target: body.envelope.target, input: request.actionArgs,
                    signature: request.executionOriginV1.externalActionInputSignature!, publicKey: installation.publicKey })).toBe(true);
                const decide = (authority: 'account_automation' | 'present_user') => executor.execute(
                    'approval.request.decide', { artifactId: 'proposal-approval', decision: 'approve' },
                    { surface: 'ui', authority, serverId: 'profile', runtimeAccountId: 'account', actionCaller: { kind: 'host' },
                        actionRequestId: `human-${actionId}` });
                expect(await decide('account_automation')).toMatchObject({ ok: false, errorCode: 'present_user_required' });
                expect(effects).toBe(0);
                const human = await decide('present_user');
                expect(human.ok).toBe(true);
                expect(human).toMatchObject({ result: { status: 'executed' } });
                expect(JSON.stringify(human).includes(bearer)).toBe(true);
                expect(effects).toBe(1);
                const repeated = await decide('present_user');
                expect(repeated.ok).toBe(true);
                expect(effects).toBe(1);
                expect(JSON.stringify(repeated).includes(bearer)).toBe(false);
                const observed = await executor.execute('approval.request.get', { artifactId: 'proposal-approval' },
                    // Status is a new request, not a child effect spending the invitation's signed root.
                    { ...context, surface: 'rpc', actionCaller: { kind: 'host' }, actionRequestId: `${body.envelope.requestId}-status`,
                        externalActionExecutionAuthorization: undefined, externalActionTarget: undefined });
                expect(observed.ok, observed.ok ? undefined : observed.errorCode).toBe(true);
                expect(JSON.stringify(observed).includes(bearer)).toBe(false);
                expect(JSON.stringify(persisted).includes(bearer)).toBe(false);
            } finally { await domain.close(); await app.close(); }
        },
    );
});
