import fastify, { type FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
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

// Database I/O is the only substitute: installation signatures, Machine and
// Session admission, credential policy, Home minting and currentness stay real.
const storage = vi.hoisted(() => {
    const state = { bound: true, publicKey: '', metadata: '', dataEncryptionKey: '', revokedAt: null as Date | null };
    const account = { id: 'account', status: 'active', tokenEpoch: 1,
        encryptionMode: 'plain', terminalPresentUserPolicy: 'never' };
    const machine = () => ({ id: 'machine', accountId: account.id, kind: 'persistent',
        installationId: 'installation', installationPublicKey: state.publicKey,
        revokedAt: state.revokedAt, replacedByMachineId: null, active: true,
        metadata: state.metadata, daemonState: null,
        dataEncryptionKey: state.dataEncryptionKey, account, accountGrants: [], teamGrants: [], groupGrants: [] });
    const reader = {
        account: { findUnique: async () => account },
        machine: { findUnique: async () => machine(), findFirst: async () => machine() },
        session: { findFirst: async () => state.bound ? { id: 'session', accountId: account.id } : null },
        accessKey: { findUnique: async () => state.bound ? { machine: machine(), session: { accountId: account.id } } : null },
        simpleCache: { findUnique: async () => ({ value: 'srv_proposal_admission' }) },
        homeSettings: { findUnique: async () => null },
        homeGovernancePolicy: { findUnique: async () => null },
    };
    const db = { ...reader, $transaction: async <T>(run: (tx: typeof reader) => Promise<T>) => run(reader) };
    return { db, state };
});
vi.mock('@/storage/db', async importOriginal => ({
    ...await importOriginal<typeof import('@/storage/db')>(), db: storage.db,
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
    beforeAll(async () => {
        vi.stubEnv('HANDY_MASTER_SECRET', 'proposal-admission-test-secret');
        vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
        vi.stubEnv('AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS', '0');
        await auth.init();
    });
    afterAll(() => vi.unstubAllEnvs());
    beforeEach(() => {
        storage.state.bound = true;
        storage.state.revokedAt = null;
        storage.state.publicKey = encodeBase64(installation.publicKey, 'base64url');
        storage.state.metadata = encodePlainMachineStoredContent({});
        storage.state.dataEncryptionKey = MACHINE_PLAIN_DATA_KEY_MARKER;
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
