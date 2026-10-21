import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { Server, type Socket } from 'socket.io';
import { decodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ExternalActionExecutionAuthorizationVerifyRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { DiscussionPostInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { encodePasswordCredentialFieldV1 } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { StopSessionResultSchema } from '@happier-dev/protocol/sessionStop';
import { auth } from '@/app/auth/auth';
import { narrowCredentialAuthority } from '@/app/auth/effectiveCredentialAuthority';
import { normalizeSocketHandshakeClientType } from '@/app/api/socket';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';
import { registerDiscussionRoutes } from '../discussions/registerDiscussionRoutes';
import { registerSessionListingRoutes } from '../session/registerSessionListingRoutes';
import { registerSessionPatchRoute } from '../session/registerSessionPatchRoute';
import { registerSessionMessageRoutes } from '../session/registerSessionMessageRoutes';
import { registerAccountEncryptionRoutes } from '../account/registerAccountEncryptionRoutes';
import { registerAccountSettingsRoutes } from '../account/registerAccountSettingsRoutes';
import { registerAccountProfileRoute } from '../account/registerAccountProfileRoute';
import { artifactsRoutes } from '../artifacts/artifactsRoutes';
import { kvRoutes } from '../kv/kvRoutes';
import { featuresRoutes } from '../features/featuresRoutes';
import { createDiscussion, postDiscussionMessage } from '@/app/discussions/mutations';
import { inviteDiscussionParticipant, removeDiscussionParticipant } from '@/app/discussions/accessService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionInputReplyProgressInTx } from '@/app/session/messages/sessionMessageReply';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { machineUpdateHandler } from '@/app/api/socket/machineUpdateHandler';
import { resolveVerifiedMachineSocketInstallationId, VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '@/app/api/socket/machineSocketInstallationProof';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import { createFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '@/app/api/testkit/socketHarness';
import { getOrCreateServerIdentityId, initializeServerIdentityCache } from '@/app/serverIdentity/serverIdentity';
import { createCliActionExecutor } from '../../../../../../cli/src/session/actions/createCliActionExecutor';
import { createCliApprovalsArtifactStore } from '../../../../../../cli/src/session/actions/approvals/artifactStore';
import { createDaemonSessionAccountActionExecutor } from '../../../../../../cli/src/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '../../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { prepareExternalActionRequesterAccountAuthorization, verifyExternalActionExecutionAuthorizationCurrent } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { readOrCreateInstallationIdentity } from '../../../../../../cli/src/daemon/identity/store';
import { createApprovedDiscussionAgentPublisher } from '../../../../../../cli/src/discussions/approvedDiscussionAgentPublisher';
import { ApiMachineClient } from '../../../../../../cli/src/api/apiMachine';
import { runWithServerHttpBaseUrl } from '../../../../../../cli/src/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '../../../../../../cli/src/settings/accountSettings/bootstrapAccountSettingsContext';
import { createStopSession } from '../../../../../../cli/src/daemon/sessions/stopSession';
import { createOnChildExited } from '../../../../../../cli/src/daemon/sessions/onChildExited';
import { retireExactTerminalControlServiceability } from '../../../../../../cli/src/daemon/sessions/retireTerminalControlServiceability';
import { readProcessIdentityByPid } from '../../../../../../cli/src/daemon/processIdentity';
import { projectMachineRpcTransportAcknowledgement } from '../../../../../../cli/src/api/machine/projectMachineRpcTransportAcknowledgement';
import { buildCurrentCliClientCompatibilitySocketAuth } from '../../../../../../cli/src/api/clientCompatibility/cliClientCompatibility';
import { createConnectedServiceCredentialApi } from '../../../../../../cli/src/api/client/connectedServiceCredentialApi';
import { hasStoredSessionCredentialProvenance, readStoredCredentialsForServerId, writeCredentialsTokenOnlyForServerId, type StoredCredentials } from '../../../../../../cli/src/persistence';
import type { TrackedSession } from '../../../../../../cli/src/daemon/types';
import { configuration } from '../../../../../../cli/src/configuration';
import { ConnectedServiceRuntimeRegistry } from '../../../../../../cli/src/daemon/connectedServices/runtimeRegistry/registry';
import { createRequesterSessionControlRuntimeFixture } from '../../../../../../cli/src/daemon/testkit/requesterSessionControlRuntimeFixture';
import { createCurrentMachineExecutionOriginContextResolver } from '../../../../../../cli/src/api/machine/resolveCurrentMachineExecutionOriginContext';

const document = (text: string) => ({ t: 'plain' as const, v: { v: 1 as const, parts: [{ t: 'text' as const, text }] } });

describe.skipIf(process.platform !== 'linux')('signed private Discussion draft after person Stop', () => {
    let database: LightSqliteHarness;
    beforeAll(async () => { database = await createLightSqliteHarness({ tempDirPrefix: 'happier-reviewed-discussion-stop-',
        initAuth: true, initEncrypt: true, env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_SESSIONS__ENABLED: '1',
            HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1' } }); }, 300_000);
    afterAll(async () => { resetInMemoryAccountSettingsContextForTests(); await database?.close(); });

    it.each(['none', 'session-access', 'participant', 'account-credential', 'home-unavailable', 'wrong-machine'] as const)(
        'posts the exact signed private draft after canonical Stop only without real revocation (%s)', async revocation => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.accountIdentity.create({ data: { accountId: account.id, provider: 'email', providerUserId: `${account.id}@review.test`, profile: {} } });
        await db.accountPasswordCredential.create({ data: { accountId: account.id, credential: { v: 1, kind: 'plain_password_hash', hash: {
            v: 1, algorithm: 'scrypt', parameters: { n: 16_384, r: 8, p: 5, keyLength: 32 },
            salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)), digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)) } } } });
        const installation = await readOrCreateInstallationIdentity();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: installation.installationId,
            installationPublicKey: decodeBase64(installation.publicKey, 'base64url'), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] }, sessionMessageReply: { protocolVersions: [1] } } } });
        const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
        const homeId = await getOrCreateServerIdentityId();
        expect(await initializeServerIdentityCache(), 'Fixture startup-published Home identity').toBe(homeId);
        const serverId = homeId;
        const child = spawn(process.execPath, ['-e', "process.send('ready');setInterval(()=>{},1000)"],
            { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const exited = once(child, 'exit');
        let apiMachine: ApiMachineClient | undefined;
        let closeSockets: (() => Promise<void>) | undefined;
        let closeHttp: (() => Promise<void>) | undefined;
        let startup: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | undefined;
        try {
        await once(child, 'message');
        const pid = child.pid!;
        const identity = await readProcessIdentityByPid(pid);
        if (!identity) throw new Error('Owned test process identity unavailable');
        const metadata = { machineId: machine.id, path: database.baseDir, hostPid: pid, permissionMode: 'default',
            hostProcessStartTimeMs: identity.processStartTimeMs, startedBy: 'daemon', sessionDirectoryV1: { v: 1, kind: 'managed' } };
        const ownerMetadata = createSessionOwnerMetadataV1({ metadata });
        if (!ownerMetadata.ok) throw new Error('Invalid canonical Session owner metadata');
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadataLayoutVersion: 1,
            metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })), ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata.ownerMetadata)), seq: 1 } });
        await db.accessKey.create({ data: { accountId: account.id, sessionId: session.id, machineId: machine.id, data: 'opaque' } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const created = await createDiscussion({ actorAccountId: account.id, authentication, request: { creationLocalId: randomUUID(),
            titleContent: { t: 'plain', v: { v: 1, title: 'Retained private Post' } }, firstMessage: { localId: randomUUID(), content: document('Context'), mentionedAccountIds: [] } } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await inviteDiscussionParticipant({ actorAccountId: account.id, authentication, discussionId,
            request: { participant: { kind: 'session', sessionId: session.id }, answerPolicy: 'drafts_for_approval' } })).toMatchObject({ ok: true });
        const asked = await postDiscussionMessage({ actorAccountId: account.id, authentication, discussionId, request: { localId: randomUUID(),
            content: { t: 'plain', v: { v: 1, parts: [{ t: 'mention', participant: { kind: 'session', sessionId: session.id } }] } },
            mentionedAccountIds: [], mentionedSessionIds: [session.id] } });
        if (!asked.ok) throw new Error(asked.error);
        const addressing = { discussionId, messageId: asked.value.message.id, throughSeq: asked.value.message.seq, participantSessionId: session.id };
        const inputId = deriveDiscussionFollowInputLocalIdV1(addressing);
        const turnId = randomUUID();
        const progress = await inTx(tx => createSessionInputReplyProgressInTx(tx, { accountId: account.id, reply: { mode: 'return', discussion: addressing } }));
        if (!progress) throw new Error('Original Discussion return custody unavailable');
        await db.sessionMessage.create({ data: { sessionId: session.id, localId: inputId, seq: 1, messageRole: 'user', content: document('Original addressed input'),
            replyProgress: { ...progress, acceptedTurnId: turnId }, replyDisposition: progress.disposition, replyTargetMachineId: machine.id } });
        await db.sessionTurn.create({ data: { sessionId: session.id, turnId, status: 'completed', startedAt: 1n, updatedAt: 2n,
            transcriptAnchorsJson: JSON.stringify({ startUserMessageSeq: 1, userMessageSeqs: [1] }) } });
        const presence = createSessionPublisherPresence();
        const publisherSocket = {};
        expect(await presence.registerPublisher({ socket: publisherSocket, binding: { accountId: account.id, machineId: machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'idle', activeCount: 0 } })).toMatchObject({ status: 'registered' });
        const tracked: TrackedSession = { pid, childProcess: child, startedBy: 'daemon', happySessionId: session.id,
            processStartTimeMs: identity.processStartTimeMs, spawnOptions: { directory: database.baseDir } };
        const sessions = new Map([[pid, tracked]]);
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        const httpOutcomes: string[] = [];
        app.addHook('onResponse', async (request, reply) => {
            // Boundary diagnostics exclude credentials, query strings and bodies.
            httpOutcomes.push(`${request.method} ${request.url.split('?')[0]} ${reply.statusCode}`);
        });
        closeHttp = () => app.close();
        app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler); enableAuthentication(app);
        // Replace socket-room discovery only. Its answer follows the real
        // tracked-runner owner that canonical Stop retires below.
        app.decorate('resolveCurrentSessionMachine', async () => sessions.has(pid) ? machine.id : null);
        registerExternalActionRoutes(app); registerDiscussionRoutes(app); registerSessionListingRoutes(app); registerSessionPatchRoute(app);
        registerSessionMessageRoutes(app); registerAccountEncryptionRoutes(app); registerAccountSettingsRoutes(app); registerAccountProfileRoute(app);
        artifactsRoutes(app); kvRoutes(app); featuresRoutes(app);
        const io = new Server(app.server, { path: '/v1/updates' });
        closeSockets = () => new Promise<void>(resolve => io.close(() => resolve()));
        let resolveMachineConnection: ((socket: Socket) => void) | undefined;
        let rejectMachineConnection: ((error: Error) => void) | undefined;
        const machineConnection = new Promise<Socket>((resolve, reject) => {
            resolveMachineConnection = resolve; rejectMachineConnection = reject;
        });
        io.use(async (socket, next) => {
            try {
                const token: unknown = socket.handshake.auth.token;
                if (typeof token !== 'string') throw new Error('Fixture handshake has no token');
                const verified = await auth.verifyTokenForRoute(token);
                const clientType = normalizeSocketHandshakeClientType(socket.handshake.auth.clientType);
                if (!verified || verified.userId !== account.id || !['account', 'terminal'].includes(verified.authTokenKind)
                    || !['machine-scoped', 'user-scoped'].includes(clientType)) throw new Error('Fixture handshake principal mismatch');
                Object.assign(socket.data, { userId: verified.userId, authTokenKind: verified.authTokenKind,
                    authAuthority: narrowCredentialAuthority(verified.authority, socket.handshake.auth.authorityCeiling),
                    authTokenAuthenticationEvidence: verified.authenticationEvidence, clientType });
                if (clientType === 'machine-scoped') {
                    if (socket.handshake.auth.machineId !== machine.id) throw new Error('Fixture Machine routing mismatch');
                    const installationId = resolveVerifiedMachineSocketInstallationId({ accountId: account.id,
                        machineId: machine.id, machine, socketAuth: socket.handshake.auth });
                    if (installationId !== installation.installationId) throw new Error('Fixture Machine installation proof unavailable');
                    Object.assign(socket.data, { machineId: machine.id,
                        [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: installationId });
                }
                const compatibility = evaluateAccountStoredContentSocketCompatibility(socket.handshake.auth);
                if (!compatibility.evaluation.supportsCurrentProtocol) throw new Error('Fixture Machine compatibility declaration unavailable');
                writeAccountStoredContentCompatibilityForSocket(socket, compatibility);
                next();
            } catch (error) {
                const refusal = error instanceof Error ? error : new Error('Fixture Machine admission failed');
                rejectMachineConnection?.(refusal); next(refusal);
            }
        });
        io.on('connection', async socket => {
            await socket.join(`user:${account.id}`);
            // The canonical requester encryption observer uses this ordinary
            // authenticated user channel before reading currentness via HTTP.
            if (socket.data.clientType !== 'machine-scoped') return;
            // The real token, installation and compatibility owners above
            // consume the actual ApiMachineClient handshake before dispatch.
            machineUpdateHandler(account.id, socket, { sessionPublisherPresence: presence,
                operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } } });
            resolveMachineConnection?.(socket);
        });
        const serverHttpBaseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
            await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
                await bootstrapAccountSettingsContext({ credentials, mode: 'blocking' });
                apiMachine = new ApiMachineClient(credentials.token, { id: machine.id, encryptionMode: 'plain', metadata: null,
                    metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
                apiMachine.connect();
                const admittedMachineSocket = await machineConnection;
                expect(await createConnectedServiceCredentialApi(credentials).getAccountEncryptionMode({ refresh: true,
                    throwOnTransportError: true }), `Fixture plain Account mode: ${JSON.stringify(httpOutcomes)}`).toBe('plain');
                const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId: machine.id,
                    serverId, serverApiUrl: serverHttpBaseUrl, isSessionCallerCurrent: async () => sessions.has(pid) });
                if (!currentness) throw new Error('Canonical credential-backed approval currentness unavailable');
                const publisher = createApprovedDiscussionAgentPublisher({ credentials, machineId: machine.id, serverId, serverUrl: serverHttpBaseUrl,
                    isApprovalExecutionOriginCurrent: currentness, publish: (publication, options) => apiMachine!.postAgentDiscussionMessage(publication, options) });
                let replayOnDaemon: ReturnType<typeof createCliActionExecutor>['replayApprovedApprovalRequest'] | undefined;
                const createExecutor = (executionCredentials: StoredCredentials, forwardApprovedReplay = false): ReturnType<typeof createCliActionExecutor> => createCliActionExecutor({ credentials: executionCredentials,
                    token: executionCredentials.token, serverId, serverIdentityId: homeId,
                    serverHttpBaseUrl, sessionId: session.id, mode: 'plain', ctx: null, isApprovalExecutionOriginCurrent: currentness,
                    externalActionMachineRequestPrivateKey: installation.privateKey,
                    externalActionMachineInstallationId: installation.installationId,
                    // Substitute only the exact-daemon RPC network hop. The
                    // actual deciding executor admits the stored interactive
                    // credential before a fresh credential-bound replay owner
                    // consumes its authenticated authority.
                    ...(forwardApprovedReplay ? { approvalRequestApprovedReplay: async ({ artifactId, context, signal }) => {
                        if (!replayOnDaemon) throw new Error('Fixture actual daemon replay is unavailable');
                        return await replayOnDaemon({ artifactId,
                            ...(context.authority ? { callerAuthority: context.authority } : {}), ...(signal ? { signal } : {}) });
                    } } : {}),
                    postAgentDiscussionMessage: async () => { throw new Error('Only the actual startup replay owner may publish this private body'); } });
                const executor = createExecutor(credentials);
                const capture = createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl, token: credentials.token, credentials, machineId: machine.id,
                    prepareExternalActionAuthorization: async ({ operation, sessionActionOrigin, isCallerCurrent }) => {
                        const target = { kind: 'machine' as const, machineId: machine.id };
                        const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId: operation.actionId, input: operation.input,
                            requestId: operation.requestId, target, machineId: machine.id, sourceMachineId: machine.id, accountId: account.id,
                            accountEncryptionMode: 'plain', tokenEpochHint: account.tokenEpoch, token: credentials.token, serverId, serverIdentityId: homeId,
                            serverHttpBaseUrl, installationId: machine.installationId!, privateKey: installation.privateKey, sessionActionOrigin, isCurrent: isCallerCurrent });
                        return authorization ? { authorization, target } : null;
                    }, createExecutor: () => ({ execute: (actionId, input, context) => executor.execute(actionId, input, { ...context,
                        serverIdentityId: homeId, runtimeAccountId: account.id, signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({
                            authorizationToken: args.authorization.token, actionId: args.actionId, input: args.input, target: args.target, privateKey: installation.privateKey }) }) }) });
                const content = { v: 1, parts: [{ t: 'text', text: 'The exact privately approved answer' }] };
                const draft = await capture({ kind: 'action.execute', actionId: 'discussion.reply', requestId: randomUUID(),
                    input: { discussionId, content, replyTarget: { kind: 'message', messageId: addressing.messageId } }, witness: {
                        turnId, inputId, userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0, callerPermissionMode: 'default', discussionAddressing: addressing,
                        agentStartCaller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 } } },
                    { sessionId: session.id, isCurrent: async () => sessions.has(pid) });
                expect(draft, JSON.stringify({ draft, httpOutcomes })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                const store = createCliApprovalsArtifactStore({ credentials, serverId, serverHttpBaseUrl });
                const open = await store.approvalsList({ serverId, status: 'open', limit: 10 });
                expect(open.items).toHaveLength(1);
                const artifactId = open.items[0]!.artifactId;
                const approval = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId, serverId }));
                expect(approval.discussionDraftReview).toBe(true);
                const binding = approval.executionOriginV1.externalActionExecutionAuthorization?.binding;
                // Project only non-secret binding facts into assertion output.
                expect({ source: binding?.sessionActionSource, origin: binding?.sessionActionOrigin }).toMatchObject({
                    origin: { sourceInputId: inputId, sourceTurnId: turnId }, source: { machineId: machine.id } });
                const initialStaleReasons: string[] = [];
                expect(await currentness({ origin: approval.executionOriginV1, request: approval,
                    reportStale: reason => initialStaleReasons.push(reason) }),
                    `Fixture signed origin current before Stop: ${JSON.stringify(initialStaleReasons)}`).toBe(true);
                expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
                const terminalToken = await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
                await writeCredentialsTokenOnlyForServerId(serverId, { token: terminalToken });
                const personCredentials = await readStoredCredentialsForServerId(serverId);
                if (!personCredentials || !hasStoredSessionCredentialProvenance(personCredentials)) throw new Error('Fixture interactive stored CLI credential unavailable');
                let currentMachineId: string | null = machine.id;
                startup = await createRequesterSessionControlRuntimeFixture({
                    happyHomeDir: configuration.happyHomeDir, activeServerDir: join(configuration.happyHomeDir, 'servers', serverId),
                    serverId, serverHttpBaseUrl, machineId: machine.id, custodianAccountId: account.id, credentials,
                    connectedServicesMaterializationBaseDir: join(database.baseDir, 'connected-services'),
                    registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: sessions, getRequester: () => null,
                    getApiMachineForSessions: () => apiMachine!,
                    resolveQualifiedConnectedAccountV4Support: () => { throw new Error('Unexpected Connected Account operation'); },
                    processEnv: { HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED: '0' },
                    startup: { resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                        serverUrl: serverHttpBaseUrl, resolveCurrentMachineId: () => currentMachineId,
                    }) },
                });
                expect(startup.installation?.installationId, 'Fixture startup retains the actual signing installation').toBe(installation.installationId);
                expect(startup.installation?.publicKey === installation.publicKey, 'Fixture startup retains the actual signing public key').toBe(true);
                const ingress = startup.runtime.externalActionIngressOwner;
                if (!ingress) throw new Error('Fixture startup-composed Action ingress is unavailable');
                // The canonical startup fixture selects the active Home. Its
                // Account settings snapshot must be admitted in that namespace,
                // not inherited from the former test profile's bootstrap.
                await bootstrapAccountSettingsContext({ credentials, mode: 'blocking' });
                expect(await currentness({ origin: approval.executionOriginV1, request: approval }),
                    'Fixture signed origin and Account policy current in the startup-selected Home before Stop').toBe(true);
                replayOnDaemon = args => ingress.executor.replayApprovedApprovalRequest(args);
                const personExecutor = createExecutor(personCredentials, true);
                const onExit = createOnChildExited({ pidToTrackedSession: sessions, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
                    getApiMachineForSessions: () => apiMachine!, removeSessionMarkerFn: async () => undefined });
                const stop = createStopSession({ pidToTrackedSession: sessions, readHostAttachmentState: async () => ({ status: 'absent' }),
                    readTerminalAttachmentInfo: async () => null, waitForTrackedRunnersExit: async () => {
                        const [code, signal] = await exited; await onExit(pid, { reason: 'process-exited', code, signal });
                        return sessions.size === 0;
                    }, retireAbsentTerminalControlServiceability: ({ trackedSession }) => retireExactTerminalControlServiceability({ credentials,
                        sessionId: session.id, terminalMode: 'plain', expectedRunner: { pid: trackedSession.pid, startTimeMs: trackedSession.processStartTimeMs } }) });
                expect(admittedMachineSocket.data[VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY], 'Fixture installed Machine identity').toBe(installation.installationId);
                expect(await resolveMachineAdmission({ actorAccountId: account.id, machineId: machine.id,
                    rpcMethod: RPC_METHODS.STOP_SESSION, requireOnline: true }), 'Fixture current Stop Machine admission')
                    .toMatchObject({ kind: 'admitted', installationId: installation.installationId });
                const target = { id: admittedMachineSocket.id, data: admittedMachineSocket.data, timeout: () => ({ emitWithAck: async (event: string, packet: unknown) => {
                    expect(event).toBe(SOCKET_RPC_EVENTS.REQUEST);
                    if (!packet || typeof packet !== 'object' || !('method' in packet) || !('params' in packet)) throw new Error('Fixture Stop RPC packet unavailable');
                    expect(packet.method).toBe(`${machine.id}:${RPC_METHODS.STOP_SESSION}`);
                    const operand = getActionSpec('session.stop').inputSchema.parse(packet.params);
                    expect(operand.sessionId).toBe(session.id);
                    const result = StopSessionResultSchema.parse(await stop(operand.sessionId));
                    return { v: 1, result, acknowledgement: projectMachineRpcTransportAcknowledgement({ method: RPC_METHODS.STOP_SESSION, result }) };
                } }) };
                const discovery = createSocketRoomDiscoveryHarness(async () => [target]);
                const person = await auth.verifyTokenForRoute(credentials.token);
                if (!person || person.userId !== account.id || person.authority !== 'present_user') throw new Error('Fixture person Stop credential unavailable');
                const caller = createFakeSocket({ data: { clientType: 'user-scoped', authTokenKind: person.authTokenKind,
                    authAuthority: person.authority, authTokenAuthenticationEvidence: person.authenticationEvidence } });
                writeAccountStoredContentCompatibilityForSocket(caller as unknown as Socket,
                    evaluateAccountStoredContentSocketCompatibility(buildCurrentCliClientCompatibilitySocketAuth('daemon')));
                registerSocketRpcHandlers({ userId: account.id, socket: caller as unknown as Socket, io: discovery, sessionPublisherPresence: presence });
                const stopped: unknown[] = [];
                await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method: `${machine.id}:${RPC_METHODS.STOP_SESSION}`,
                    params: { sessionId: session.id }, authorization: { kind: 'session.write', sessionId: session.id } }, (value: unknown) => stopped.push(value));
                expect(stopped).toEqual([{ ok: true, result: { status: 'stopped' } }]);
                expect(sessions.size).toBe(0);
                expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { active: true } })).toEqual({ active: false });
                const authorization = approval.executionOriginV1.externalActionExecutionAuthorization;
                const originalTarget = approval.executionOriginV1.target;
                const originalSource = approval.executionOriginV1.sessionInputSource;
                if (!authorization || !originalTarget || !originalSource) throw new Error('Fixture signed original proof unavailable');
                const { sourceTurnId: _acceptedTurn, ...unacceptedSource } = originalSource;
                expect(ExternalActionExecutionAuthorizationVerifyRequestV1Schema.safeParse({ v: 1,
                    retainedDiscussionSource: unacceptedSource }).success, 'An unaccepted original is not retained-turn proof').toBe(false);
                const verification = { authorization, effectActionId: approval.actionId, target: originalTarget,
                    privateKey: installation.privateKey, installationId: installation.installationId, serverHttpBaseUrl };
                // Retiring this source does not waive ordinary root currentness
                // or accept an unrelated retained input under the same signer.
                expect(await verifyExternalActionExecutionAuthorizationCurrent(verification)).toBe(false);
                expect(await verifyExternalActionExecutionAuthorizationCurrent({ ...verification,
                    retainedDiscussionSource: { ...originalSource, sourceInputId: 'not-the-original' } })).toBe(false);
                const capturedInput = DiscussionPostInputV1Schema.parse(approval.actionArgs);
                // Neither a direct draft nor its still-open Artifact reference
                // gains publication authority merely because the host stopped.
                expect(await publisher({ v: 1, sessionId: session.id, discussionId, request: {
                    localId: capturedInput.localId!, content: { t: 'plain', v: capturedInput.content },
                    mentionedAccountIds: [], replyTarget: capturedInput.replyTarget,
                } }, { approvedActionReplay: { artifactId }, callerAuthority: 'present_user' }))
                    .toMatchObject({ ok: false, error: 'discussion_post_denied' });
                expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(2);
                if (revocation === 'session-access') await db.accessKey.delete({ where: { accountId_machineId_sessionId: {
                    accountId: account.id, machineId: machine.id, sessionId: session.id } } });
                if (revocation === 'participant') expect(await removeDiscussionParticipant({ actorAccountId: account.id, authentication,
                    discussionId, request: { participant: { kind: 'session', sessionId: session.id } } })).toMatchObject({ ok: true });
                if (revocation === 'account-credential') await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } });
                if (revocation === 'home-unavailable') currentMachineId = null;
                if (revocation === 'wrong-machine') currentMachineId = randomUUID();
                const result = await personExecutor.execute('approval.request.decide', { artifactId, decision: 'approve' },
                    { serverId, serverIdentityId: homeId, surface: 'cli' });
                const rows = await db.discussionMessage.findMany({ where: { discussionId, seq: { gt: addressing.throughSeq } } });
                if (revocation === 'none') {
                    expect(result, JSON.stringify({ result, httpOutcomes, publishedRows: rows.length })).toMatchObject({ ok: true, result: { status: 'executed' } });
                    expect(rows).toHaveLength(1);
                    expect(rows[0]).toMatchObject({ content: { t: 'plain', v: content }, producerV1: { kind: 'agent', sessionId: session.id,
                        sourceSession: { sourceSessionId: session.id, sourceInputId: inputId, sourceTurnId: turnId } } });
                    expect(httpOutcomes.filter(value => value.startsWith('POST /v1/discussions/'))).toEqual([]);
                    const settled = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId, serverId }));
                    expect(sameStrictJsonValue(settled.executionOriginV1, approval.executionOriginV1), 'Original signed provenance remains immutable').toBe(true);
                    expect(await personExecutor.replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' }))
                        .toMatchObject({ ok: true, result: { status: 'executed' } });
                    expect(await db.discussionMessage.count({ where: { discussionId, seq: { gt: addressing.throughSeq } } })).toBe(1);
                } else {
                    expect(result).not.toMatchObject({ ok: true, result: { status: 'executed' } });
                    expect(rows).toHaveLength(0);
                }
                expect(sessions.size).toBe(0);
            });
        } finally {
            if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
            await startup?.dispose();
            await apiMachine?.shutdown(); await closeSockets?.(); await closeHttp?.();
            resetInMemoryAccountSettingsContextForTests();
        }
    });
});
