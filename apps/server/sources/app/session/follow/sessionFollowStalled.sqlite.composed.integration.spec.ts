import { randomUUID } from 'node:crypto';
import axios, { AxiosError } from 'axios';
import { decodeBase64 } from 'privacy-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountEncryptionCurrentnessResponse, SessionFollowPendingObservationV1,
    SessionFollowUpdateEnvelopeV1, V2SessionRecord, WorkerUpdateV1 } from '@happier-dev/protocol';
import type { SessionFollowObservePendingRequestV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SESSION_FOLLOW_WAKE_EVENT_MESSAGE, SessionFollowAcknowledgeRequestV1Schema, SessionFollowAcknowledgeResponseV1Schema, TranscriptRawAgentEventV1Schema } from '@happier-dev/protocol';
import { renderSessionInputContextPromptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { serializeFollowPolicyV1, type FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } from '@happier-dev/protocol/sessions/control/contract';
import { AccountVoiceFollowAcknowledgeRequestV1Schema, AccountVoiceFollowObservePendingResponseV1Schema, type AccountVoiceFollowAcknowledgeRequestV1 } from '@happier-dev/protocol/sessions/follow/accountVoiceFollowTransportV1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createSessionPublisherPresence, expireSessionPublisherCandidates } from '@/app/presence/sessionPublisherPresence';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { sessionUpdateHandler } from '@/app/api/socket/sessionUpdateHandler';
import { SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1, SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1,
    SessionFollowObservePendingResponseV1Schema, SessionFollowObserveSourceRoutesRequestV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { readSessionManagerInTx, setSessionManager } from '@/app/session/follow/sessionManagerService';
import { parseStoredSessionLatestTurnStatus } from '@/app/session/listing/rows';
import { readCurrentSourceSessionFollowFrontier, writeSessionFollowFrontierColumns } from '@/app/session/relations/sessionEdgeFrontier';
import { acknowledgeSessionFollowFrontierInTx, observePendingSessionFollowForDestinationInTx, setSessionFollowSource } from './sessionFollowEdgeService';
import { acknowledgeAccountVoiceFollowInTx, observePendingAccountVoiceFollowInTx, setAccountSessionFollow } from './accountFollowService';
import { acknowledgeAdmittedSessionFollowInputInTx } from './sessionFollowEdgeService';
import { sessionFollowInputFrontiers } from './sessionFollowRuleProgress';
import { auth } from '@/app/auth/auth';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { registerSessionFollowRoutes } from '@/app/api/routes/session/registerSessionFollowRoutes';
import { registerSessionFollowSourceRoutes } from '@/app/api/routes/session/registerSessionFollowSourceRoutes';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { materializeNextPendingMessage } from '@/app/session/pending/materializeNextPendingMessage';
import { resolveAcceptedPendingDelivery } from '@/app/session/pending/pendingMessageService';
import { readStoredSessionInputAdmissionReceipt } from '@/app/session/messages/sessionInputAdmission';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import type { SessionFollowInputV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { SessionFollowRuleSourceOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import { buildTrustedHostSessionInputAdmissionV1, settleSessionInputRequestV1, settleSessionMessageProvenanceV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { clearSessionExplicitStopV1FromMetadata, writeSessionExplicitStopV1ToMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';

describe('session → Follow WorkerUpdate acceptance', () => {
    let harness: LightSqliteHarness;
    const cleanups: (() => void | Promise<void>)[] = [];
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-follow-stalled-', initAuth: true,
        env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: 'true' } }); }, 180_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
        await db.sessionPendingMessage.deleteMany();
        await db.sessionMessage.deleteMany();
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    async function fixture(status: 'in_progress' | 'completed' = 'in_progress', policy: FollowPolicyV1 = { preset: 'everything' }) {
        // Nearest-project Vitest resolution loads real CLI owners without
        // pulling CLI aliases into the server's TypeScript compilation.
        const { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } = await vi.importActual<{
            createAccountEncryptionCurrentnessFixture: () => AccountEncryptionCurrentnessResponse;
            createSessionRecordFixture: (input: Partial<V2SessionRecord> & { id: string }) => V2SessionRecord;
        }>('../../../../../cli/src/testkit/backends/sessionFixtures');
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const source = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'plain',
            metadata: JSON.stringify({ path: '/worker', host: 'host' }), active: true,
            lastActiveAt: new Date(0), latestTurnId: 'worker-turn', latestTurnStatus: status, seq: 1,
        } });
        const originalLocalId = randomUUID();
        await db.sessionMessage.create({ data: {
            sessionId: source.id, seq: 1, localId: originalLocalId, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Investigate the source work' } } },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: account.id, sessionRelationship: 'owner' },
            acceptedTurnId: 'worker-turn', acceptedTurnKind: 'newTurn', turnStartWitnessId: 'worker-turn',
        } });
        const appendTurnInput = async (turnId: string) => {
            const seq = (await db.session.findUniqueOrThrow({ where: { id: source.id } })).seq + 1;
            await db.sessionMessage.create({ data: {
                sessionId: source.id, seq, localId: randomUUID(), messageRole: 'user',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Continue the investigation' } } },
                acceptedTurnId: turnId, acceptedTurnKind: 'newTurn', turnStartWitnessId: turnId,
                autonomousExchangeRootSessionId: source.id, autonomousExchangeRootLocalId: originalLocalId,
            } });
            await db.session.update({ where: { id: source.id }, data: { seq } });
        };
        const destination = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}', publisherGeneration: 1n,
        } });
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        const principal = { kind: 'destination_runtime' as const, destinationRuntimeAccountId: account.id, authentication };
        expect(await setSessionManager({ accountId: account.id, sessionId: source.id,
            managerSessionId: destination.id, expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
        await db.sessionFollowEdge.update({ where: { managerSourceSessionId: source.id },
            data: { ...writeSessionFollowFrontierColumns(readCurrentSourceSessionFollowFrontier(source)), policyJson: serializeFollowPolicyV1(policy) } });
        const observe = (options?: Pick<SessionFollowObservePendingRequestV1, 'wakeAdmission' | 'inputLocalIds'>) => inTx((tx) => observePendingSessionFollowForDestinationInTx(tx, {
            principal, destinationSessionId: destination.id, includeManager: true,
            ...(options?.inputLocalIds ? { inputLocalIds: options.inputLocalIds } : {}),
            ...(options?.wakeAdmission ? { wakeAdmission: { ...options.wakeAdmission, autonomousCheckIn: { afterTurns: 5 } } } : {}),
        }));
        const acknowledgements: Array<Promise<unknown>> = [];
        const ackTransport = { attachedAtOffset: 0, retryable: false, beforeAcknowledge: async () => {} };
        // Socket and HTTP adapters are boundaries; presence, observation, hydration,
        // admission and ACK all execute their real owners against SQLite.
        const session = {
            sessionId: destination.id,
            runSessionFollowSourceRequest: async <T>({ request }: { request: () => Promise<T> }) => await request(),
            observePendingSessionFollow: async (options?: Pick<SessionFollowObservePendingRequestV1, 'wakeAdmission' | 'inputLocalIds'>) => ({ ok: true,
                publisherGeneration: (await db.session.findUniqueOrThrow({ where: { id: destination.id } })).publisherGeneration.toString(),
                ...await observe(options) }),
            acknowledgeSessionFollow: (request: Omit<Parameters<typeof acknowledgeSessionFollowFrontierInTx>[1],
                'principal' | 'destinationSessionId' | 'expectedPublisherGeneration'> & { expectedPublisherGeneration: string }): Promise<
                    Awaited<ReturnType<typeof acknowledgeSessionFollowFrontierInTx>> | ReturnType<typeof SessionFollowAcknowledgeResponseV1Schema.parse>> => {
                const parsed = SessionFollowAcknowledgeRequestV1Schema.parse({ ...request, v: 1, destinationSessionId: destination.id });
                const ack = ackTransport.beforeAcknowledge().then(() => ackTransport.retryable
                    ? SessionFollowAcknowledgeResponseV1Schema.parse({ ok: false, v: 1, error: 'retryable' })
                    : inTx((tx) => 'localInputId' in parsed
                    ? acknowledgeAdmittedSessionFollowInputInTx(tx, { principal, request: parsed })
                    : acknowledgeSessionFollowFrontierInTx(tx, {
                    ...SessionFollowAcknowledgeRequestV1Schema.parse({ ...request,
                        attachedAt: request.attachedAt === undefined ? undefined : request.attachedAt + ackTransport.attachedAtOffset,
                        v: 1, destinationSessionId: destination.id }),
                    principal, expectedPublisherGeneration: BigInt(request.expectedPublisherGeneration),
                })));
                acknowledgements.push(ack);
                return ack;
            },
        };
        const hydrateOptions = { session,
            credentials: { token: 'test', encryption: null }, deps: {
                resolveSourceTransport: async () => {
                    const row = await db.session.findUniqueOrThrow({ where: { id: source.id } });
                    return { ok: true, sessionId: row.id, mode: 'plain', ctx: null,
                        accountEncryptionCurrentness: createAccountEncryptionCurrentnessFixture(),
                        rawSession: createSessionRecordFixture({ id: row.id, seq: row.seq, metadata: row.metadata,
                            encryptionMode: 'plain', active: row.active,
                            latestTurnStatus: parseStoredSessionLatestTurnStatus(row.latestTurnStatus), latestTurnId: row.latestTurnId,
                            createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(),
                            activeAt: row.lastActiveAt.getTime(), archivedAt: null,
                            latestTurnStatusObservedAt: row.latestTurnStatusObservedAt === null ? null : Number(row.latestTurnStatusObservedAt),
                            pendingReviewRuns: 0 }),
                    };
                },
                fetchTranscriptPage: async (query: { afterSeq?: number; beforeSeq?: number; limit: number }) => ({
                    messages: (await db.sessionMessage.findMany({ where: { sessionId: source.id,
                        seq: { gt: query.afterSeq, lt: query.beforeSeq } },
                        orderBy: { seq: query.afterSeq === undefined ? 'desc' : 'asc' }, take: query.limit }))
                        .map((row) => ({ seq: row.seq, createdAt: row.createdAt.getTime(), content: row.content })),
                    hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
                }),
            },
        };
        type HydratedUpdate = SessionFollowUpdateEnvelopeV1 & { workerUpdate?: WorkerUpdateV1 };
        const { createSessionFollowSourceHydrator } = await vi.importActual<{
            createSessionFollowSourceHydrator: (options: Omit<typeof hydrateOptions, 'deps'> & { deps?: typeof hydrateOptions.deps }) => (input: {
                observation: SessionFollowPendingObservationV1; signal: AbortSignal;
            }) => Promise<HydratedUpdate | null>;
        }>('../../../../../cli/src/agent/runtime/session/follow/sessionFollowSourceHydrator');
        let hydrateObservation = createSessionFollowSourceHydrator(hydrateOptions);
        type PreparedContext = {
            workerUpdates?: readonly WorkerUpdateV1[];
            workerUpdateEvents?: readonly { localId: string; update: WorkerUpdateV1 }[];
            representedFollowLocalInputIds?: readonly string[];
            updates: readonly SessionFollowUpdateEnvelopeV1[];
            wakeEventLocalId?: string;
            recheckAdmission: (signal: AbortSignal) => Promise<boolean>;
            acknowledgeAccepted: (input: { kind: 'context_only_wake'; eventLocalId: string }
                | { kind: 'admitted_input'; localInputId: string; userMessageSeq: number | null }, pendingSettlement?: Promise<void>) => void;
        };
        const { createSessionFollowContextReconciler } = await vi.importActual<{
            createSessionFollowContextReconciler: (options: {
                session: typeof session; hydrateObservation: typeof hydrateObservation; maxFollowContextUtf8Bytes: number;
            }) => (input: { signal: AbortSignal; deliveryIntent: 'wake' | 'natural'; maxFollowContextUtf8Bytes?: number;
                followDeliveries?: readonly { delivery: SessionFollowInputV1; localInputId: string; userMessageSeq: number | null }[] }) => Promise<PreparedContext | null>;
        }>('../../../../../cli/src/agent/runtime/session/follow/sessionFollowContextReconciler');
        const makeReconciler = () => createSessionFollowContextReconciler({
            session, hydrateObservation, maxFollowContextUtf8Bytes: 8192,
        });
        const reconcile = makeReconciler();
        const wake = (owner = reconcile) => owner({ signal: new AbortController().signal, deliveryIntent: 'wake' });
        const offline = () => expireSessionPublisherCandidates({ candidates: [{ sessionId: source.id, observedFence: source.lastActiveAt }] });
        const advanceTranscript = async () => {
            await db.sessionMessage.create({ data: { sessionId: source.id, seq: 2, messageRole: 'agent',
                content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Still working' } } } },
                transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
            await db.session.update({ where: { id: source.id }, data: { seq: 2 } });
        };
        const commitWorkerWake = async (prepared: PreparedContext) => {
            const event = prepared.workerUpdateEvents![0]!;
            // Persist the real producer's card at the transcript transport
            // boundary under its actual identity, not a fabricated Follow message.
            const seq = await db.sessionMessage.count({ where: { sessionId: destination.id } }) + 1;
            await db.sessionMessage.create({ data: { sessionId: destination.id, seq,
                localId: event.localId, messageRole: 'event',
                content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', agentId: 'codex', data: {
                    id: event.localId, type: 'event',
                    data: TranscriptRawAgentEventV1Schema.parse({ type: 'worker-update', update: event.update }),
                } } } },
                transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
        };
        const follow = async (policy: FollowPolicyV1 = { preset: 'quiet' }) => {
            expect(await setSessionFollowSource({ accountId: account.id, sourceSessionId: source.id,
                destinationSessionId: destination.id, policy, authentication })).toMatchObject({ ok: true });
        };
        const detachManager = async () => {
            expect(await setSessionManager({ accountId: account.id, sessionId: source.id,
                managerSessionId: null, expectedManagerSessionId: destination.id, authentication })).toMatchObject({ ok: true });
        };
        const acceptedPrompts: string[] = [];
        const originals = async (usePublisherSocket = false, entry: 'receiver' | 'source' = 'receiver') => {
            const homeId = await getOrCreateServerIdentityId();
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(),
                active: true, metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
            await db.accessKey.create({ data: { accountId: account.id, sessionId: destination.id, machineId: machine.id, data: 'opaque' } });
            await db.session.update({ where: { id: destination.id }, data: { active: true, lastActiveAt: new Date(1),
                metadata: JSON.stringify({ machineId: machine.id, path: '/receiver', host: 'host' }),
                runtimeMachineTarget: { homeId, accountId: account.id, sessionId: destination.id,
                    machineId: machine.id, installationId: machine.installationId! } } });
            if (entry === 'source') {
                await db.accessKey.create({ data: { accountId: account.id, sessionId: source.id, machineId: machine.id, data: 'opaque' } });
                await db.session.update({ where: { id: source.id }, data: {
                    metadata: JSON.stringify({ machineId: machine.id, path: '/worker', host: 'host' }),
                    runtimeMachineTarget: { homeId, accountId: account.id, sessionId: source.id,
                        machineId: machine.id, installationId: machine.installationId! },
                } });
            }
            const presence = createSessionPublisherPresence();
            if (entry === 'source') {
                const sourceSocket = createAuthenticatedFakeSocket({ id: randomUUID() });
                expect(await presence.registerPublisher({ socket: sourceSocket,
                    binding: { accountId: account.id, sessionId: source.id, machineId: machine.id },
                    completeActivitySnapshot: { state: 'idle', activeCount: 0 } })).toMatchObject({ status: 'registered' });
                cleanups.push(() => presence.forgetDisconnectedPublisher({ socket: sourceSocket }));
            }
            const binding = { accountId: account.id, sessionId: destination.id, machineId: machine.id };
            const nsp = { server: createSocketRoomDiscoveryHarness(async () => []) };
            let publisherSocket = createAuthenticatedFakeSocket({ id: randomUUID(), nsp });
            const replacePublisher = async () => {
                publisherSocket = createAuthenticatedFakeSocket({ id: randomUUID(), nsp });
                expect(await presence.registerPublisher({ socket: publisherSocket, binding,
                    completeActivitySnapshot: { state: 'idle', activeCount: 0 } })).toMatchObject({ status: 'registered' });
                sessionUpdateHandler(account.id, publisherSocket as never, { connectionType: 'session-scoped',
                    socket: publisherSocket, userId: account.id, sessionId: destination.id } as never, { presence, binding });
            };
            if (usePublisherSocket) {
                await db.machine.update({ where: { id: machine.id }, data: { operationProtocolCapabilities: {
                    sessionInputAdmission: { protocolVersions: [1] }, sessionFollow: { contextV1: true },
                } } });
                await replacePublisher();
                cleanups.push(() => presence.forgetDisconnectedPublisher({ socket: publisherSocket }));
                session.observePendingSessionFollow = async options => {
                    let response: unknown;
                    await getSocketHandler(publisherSocket, SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1)({ v: 1,
                        sessionId: destination.id, includeManager: true, supportsWakeAdmission: true,
                        ...(options?.inputLocalIds ? { inputLocalIds: options.inputLocalIds } : {}),
                        ...(options?.wakeAdmission ? { wakeAdmission: options.wakeAdmission } : {}) },
                    (value: unknown) => { response = value; });
                    const result = SessionFollowObservePendingResponseV1Schema.parse(response);
                    if (!result.ok) throw new Error(`Follow observation refused: ${result.error}`);
                    return result;
                };
                session.acknowledgeSessionFollow = request => {
                    const ack = (async () => {
                        let response: unknown;
                        await getSocketHandler(publisherSocket, SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1)(
                            { ...request, v: 1, destinationSessionId: destination.id },
                            (value: unknown) => { response = value; });
                        return SessionFollowAcknowledgeResponseV1Schema.parse(response);
                    })();
                    acknowledgements.push(ack);
                    return ack;
                };
            }
            const app = createAuthenticatedTestApp({ authentication: 'real' });
            const requests: { url: string; status: number }[] = [];
            const admissionFault = { originalSeq: null as number | null, boundary: 'admission' as 'admission' | 'routes',
                timeoutAfterCommitSeq: null as number | null };
            const rulesReadBarrier: { beforeRead?: () => Promise<void> } = {};
            app.addHook('preHandler', async (request, reply) => {
                if (request.method === 'GET' && request.url === '/v2/account/session-follow-rules') await rulesReadBarrier.beforeRead?.();
                const body = request.body;
                const delivery = body && typeof body === 'object' && 'followDeliveryV1' in body
                    ? SessionFollowInputV1Schema.safeParse(body.followDeliveryV1) : null;
                const routes = admissionFault.boundary === 'routes' ? SessionFollowObserveSourceRoutesRequestV1Schema.safeParse(body) : null;
                const seq = admissionFault.boundary === 'admission'
                    ? delivery?.success && 'sourceMessage' in delivery.data.original ? delivery.data.original.sourceMessage.seq : undefined
                    : routes?.success ? routes.data.sourceMessage?.seq : undefined;
                if (seq === admissionFault.originalSeq) {
                    return reply.code(503).send({ error: 'test_transport_unavailable' });
                }
            });
            app.addHook('onResponse', async (request, reply) => { requests.push({ url: request.url, status: reply.statusCode }); });
            sessionPendingRoutes(app);
            registerSessionFollowRoutes(app);
            registerSessionFollowSourceRoutes(app);
            registerSessionListingRoutes(app);
            registerSessionMessageRoutes(app);
            registerAccountEncryptionRoutes(app);
            await app.ready();
            cleanups.push(() => app.close());
            const { installAxiosFastifyAdapter } = await vi.importActual<{
                installAxiosFastifyAdapter(input: { app: typeof app; origin: string }): () => void;
            }>('../../../../../cli/src/testkit/http/axiosAdapter');
            cleanups.push(installAxiosFastifyAdapter({ app, origin: 'http://original-follow.test' }));
            const httpAdapter = axios.getAdapter(axios.defaults.adapter);
            axios.defaults.adapter = async config => {
                const response = await httpAdapter(config);
                if (config.method === 'post' && new URL(config.url!).pathname === `/v2/sessions/${destination.id}/pending`) {
                    const body: unknown = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
                    const delivery = body && typeof body === 'object' && 'followDeliveryV1' in body
                        ? SessionFollowInputV1Schema.safeParse(body.followDeliveryV1) : null;
                    if (delivery?.success && 'sourceMessage' in delivery.data.original
                        && delivery.data.original.sourceMessage.seq === admissionFault.timeoutAfterCommitSeq) {
                        // The HTTP reply is lost after the real Pending transaction commits.
                        throw new AxiosError('Test admission reply deadline', 'ECONNABORTED', config);
                    }
                }
                return response;
            };
            const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
            const { runWithServerHttpBaseUrl } = await vi.importActual<{
                runWithServerHttpBaseUrl: <T>(origin: string, run: () => Promise<T>) => Promise<T>;
            }>('../../../../../cli/src/api/client/serverHttpBaseUrl');
            session.runSessionFollowSourceRequest = ({ request }) => runWithServerHttpBaseUrl('http://original-follow.test', request);
            // Original hydration uses the same real authenticated source reads
            // as the dispatcher. Only the HTTP carrier is adapted to Fastify.
            hydrateObservation = createSessionFollowSourceHydrator({ session, credentials: { token, encryption: null } });
            const { createSessionFollowOccurrenceDispatcher } = await vi.importActual<{
                createSessionFollowOccurrenceDispatcher(input: { accountId: string; credentials: { token: string; encryption: null };
                    serverId: string; serverHttpBaseUrl: string; machineId: string; installationId: string; signal: AbortSignal;
                    isCurrent: () => Promise<boolean>; subscribeInvalidation: () => () => void;
                    isPersonalCurrent: () => boolean;
                    rulesCache?: unknown;
                    resolveSourceKeyContext: () => Promise<null>; dispatchPersonal: () => Promise<void> }): {
                        dispatch(occurrence: SessionFollowRuleSourceOccurrenceV1): Promise<unknown>;
                        dispatchReceiverRange(input: { observations: SessionFollowPendingObservationV1[]; destinationSessionId: string }): Promise<unknown>;
                        dispose(): void;
                    };
            }>('../../../../../cli/src/agent/runtime/session/follow/sessionFollowOccurrenceDispatcher');
            const { createAccountSessionFollowRuleCache } = await vi.importActual<{
                createAccountSessionFollowRuleCache(input: { accountId: string; credentials: { token: string; encryption: null };
                    serverHttpBaseUrl: string; signal: AbortSignal; isCurrent: () => Promise<boolean>;
                    subscribeInvalidation: () => () => void }): { dispose(): void; hasEnabledSessionReceiver(sessionId: string): Promise<boolean> };
            }>('../../../../../cli/src/agent/runtime/session/follow/accountSessionFollowRuleCache');
            const lifetime = new AbortController();
            const rulesCache = createAccountSessionFollowRuleCache({ accountId: account.id, credentials: { token, encryption: null },
                serverHttpBaseUrl: 'http://original-follow.test', signal: lifetime.signal,
                isCurrent: async () => true, subscribeInvalidation: () => () => {} });
            cleanups.push(() => { lifetime.abort(); rulesCache.dispose(); });
            const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: account.id, credentials: { token, encryption: null },
                serverId: homeId, serverHttpBaseUrl: 'http://original-follow.test', machineId: machine.id,
                installationId: machine.installationId!, signal: new AbortController().signal, isCurrent: async () => true,
                isPersonalCurrent: () => false,
                rulesCache,
                subscribeInvalidation: () => () => {}, resolveSourceKeyContext: async () => null, dispatchPersonal: async () => {} });
            cleanups.push(() => dispatcher.dispose());
            const deliveries: { delivery: SessionFollowInputV1; localInputId: string; userMessageSeq: number | null }[] = [];
            // Match the real host's request-lifetime owner. Tests which replace
            // that host must explicitly restart it instead of dropping custody
            // at every preparation boundary.
            let originalReconcile = makeReconciler();
            const restart = () => { originalReconcile = makeReconciler(); };
            const dispatchReceiverPending = async (observations?: SessionFollowPendingObservationV1[]) => dispatcher.dispatchReceiverRange({
                observations: observations ?? (await observe()).observations, destinationSessionId: destination.id,
            });
            const sourceListeners = new Set<(sessionId: string | null) => void>();
            let requesterCurrent = true;
            const { createRequesterSessionFollowSourceReconciliation } = await vi.importActual<{
                createRequesterSessionFollowSourceReconciliation(input: { bootstrap: {
                    getBoundSessionId(): string;
                    subscribeSessionFollowSources(listener: (sessionId: string | null) => void): () => void;
                }; sessionFollowRuleCache: typeof rulesCache; isCurrent: () => Promise<boolean> }): {
                    bind(reconcile: (sessionId: string | null) => Promise<void>, signal: AbortSignal): void;
                    dispose(): void;
                };
            }>('../../../../../cli/src/daemon/sessionEncryption/requesterSessionFollowSourceReconciliation');
            const recovery = createRequesterSessionFollowSourceReconciliation({ bootstrap: {
                getBoundSessionId: () => destination.id,
                subscribeSessionFollowSources: listener => { sourceListeners.add(listener); return () => { sourceListeners.delete(listener); }; },
            }, sessionFollowRuleCache: rulesCache, isCurrent: async () => requesterCurrent });
            const recoveries: Promise<unknown>[] = [];
            recovery.bind(async sourceSessionId => {
                const work = dispatcher.dispatchReceiverRange({ destinationSessionId: destination.id,
                    observations: (await observe()).observations.filter(observation => !sourceSessionId || observation.sourceSessionId === sourceSessionId) });
                recoveries.push(work);
                await work;
            }, lifetime.signal);
            cleanups.push(async () => { recovery.dispose(); await Promise.allSettled(recoveries); });
            const sourceChanged = (sessionId: string | null, current = true) => {
                requesterCurrent = current;
                for (const listener of sourceListeners) listener(sessionId);
            };
            const dispatchPending = async () => {
                if (entry === 'receiver') return dispatchReceiverPending();
                const { readCommittedSessionFollowSourceOccurrence } = await vi.importActual<{
                    readCommittedSessionFollowSourceOccurrence(input: {
                        sourceSessionId: string; serverId: string; ownerAccountId: string; origin: null;
                        row: unknown; mode: 'plain'; ctx: null;
                    }): { status: 'occurrence'; occurrence: Omit<Extract<SessionFollowRuleSourceOccurrenceV1,
                        { sourceMessage: unknown }>, 'sourcePublisher'> } | { status: 'not_semantic' | 'unavailable' };
                }>('../../../../../cli/src/agent/runtime/session/follow/sessionFollowRuleSourceEvidence');
                const { fetchEncryptedTranscriptMessagesPage } = await vi.importActual<{
                    fetchEncryptedTranscriptMessagesPage(input: { token: string; sessionId: string; afterSeq: number; limit: number }):
                        Promise<{ messages: readonly unknown[]; hasMore: boolean }>;
                }>('../../../../../cli/src/session/replay/fetchEncryptedTranscriptMessages');
                const currentSource = await db.session.findUniqueOrThrow({ where: { id: source.id } });
                const page = await runWithServerHttpBaseUrl('http://original-follow.test', () => fetchEncryptedTranscriptMessagesPage({
                    token, sessionId: source.id, afterSeq: 0, limit: SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1,
                }));
                expect(page.hasMore).toBe(false);
                // Each persisted source original notifies the source daemon independently.
                // An earlier failed Pending POST must not let a later notification skip it.
                for (const row of page.messages) {
                    const read = readCommittedSessionFollowSourceOccurrence({ sourceSessionId: source.id, serverId: homeId,
                        ownerAccountId: account.id, origin: null, row, mode: 'plain', ctx: null });
                    if (read.status !== 'occurrence') continue;
                    await dispatcher.dispatch({ ...read.occurrence, sourcePublisher: { machineId: machine.id,
                        publisherGeneration: currentSource.publisherGeneration.toString(), committedFenceMs: currentSource.lastActiveAt.getTime() } });
                }
            };
            const prepare = async (intent: 'natural' | 'wake', maxFollowContextUtf8Bytes?: number, collectRetainedContext = false,
                recovery: 'configured' | 'receiver' | 'admitted' = 'configured') => {
                if (recovery === 'receiver') await dispatchReceiverPending();
                else if (recovery === 'configured') await dispatchPending();
                for (;;) {
                    const retained = collectRetainedContext ? await db.sessionPendingMessage.findMany({
                        where: { sessionId: destination.id, localId: { in: deliveries.map(row => row.localInputId) } },
                        select: { localId: true },
                    }) : [];
                    const materialized = await materializeNextPendingMessage({ actorUserId: account.id, sessionId: destination.id,
                        publisherAuthority: { accountId: account.id, sessionId: destination.id, machineId: machine.id,
                            committedFence: (await db.session.findUniqueOrThrow({ where: { id: destination.id } })).lastActiveAt },
                        deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready',
                        ...(retained.length ? { retainedContext: { localIds: retained.map(row => row.localId) } } : {}) });
                    expect(materialized).toMatchObject({ ok: true });
                    if (materialized.ok && materialized.didMaterialize) {
                        const message = materialized.message;
                        const receipt = readStoredSessionInputAdmissionReceipt(message.inputAdmissionReceipt);
                        if (!receipt?.followDeliveryV1 || !message.localId) throw new Error('Expected admitted original custody');
                        if (!deliveries.some(row => row.localInputId === message.localId)) {
                            deliveries.push({ delivery: receipt.followDeliveryV1, localInputId: message.localId, userMessageSeq: message.seq });
                        } else break;
                    }
                    if (!collectRetainedContext || !materialized.ok || !materialized.didMaterialize) break;
                }
                const unsettled = [];
                for (const delivery of deliveries) {
                    const row = await db.sessionMessage.findUnique({ where: { sessionId_localId: {
                        sessionId: destination.id, localId: delivery.localInputId } } });
                    if (!row?.acceptedTurnId) unsettled.push(delivery);
                }
                const prepared = await originalReconcile({ signal: new AbortController().signal, deliveryIntent: intent,
                    followDeliveries: unsettled, ...(maxFollowContextUtf8Bytes === undefined ? {} : { maxFollowContextUtf8Bytes }) });
                if (prepared) expect(deliveries.length, JSON.stringify(requests)).toBeGreaterThan(0);
                return prepared;
            };
            const settleAcceptance = async (localId: string) => {
                expect(await resolveAcceptedPendingDelivery({ actorUserId: account.id, sessionId: destination.id,
                    publisherAuthority: { accountId: account.id, sessionId: destination.id, machineId: machine.id,
                        committedFence: (await db.session.findUniqueOrThrow({ where: { id: destination.id } })).lastActiveAt },
                    localId, acceptedTurn: { kind: 'followUp', turnId: 'receiver-turn' },
                    acceptedDelivery: { t: 'plain', v: { v: 1, acceptedAtMs: 1, delivery: { kind: 'followUp', turnId: 'receiver-turn' } } } }))
                    .toMatchObject({ ok: true, didResolve: true });
            };
            const { createSessionProviderInputOutcomeNormalizer } = await vi.importActual<{
                createSessionProviderInputOutcomeNormalizer(input: {
                    getTarget(): { sessionId: string; hasPendingProviderInput(localId: string): boolean;
                        observeProviderInputSettlement(outcome: { localId: string }): Promise<boolean> };
                    observeAcceptedEffect(localId: string, pendingSettlement?: Promise<void>): void;
                }): (outcome: { type: 'input-accepted'; localId: string; userMessageSeq: number | null;
                    delivery: { kind: 'followUp'; turnId: string } }) => void;
            }>('../../../../../cli/src/agent/runtime/session/input/providerInputOutcome');
            const acceptNative = (prepared: PreparedContext, beforeSettlement = Promise.resolve()) => {
                acceptedPrompts.push(renderSessionInputContextPromptV1({ transformedUserText: '',
                    sessionFollowUpdates: prepared.updates, workerUpdates: prepared.workerUpdates }));
                const settlements: Promise<boolean>[] = [];
                const observe = createSessionProviderInputOutcomeNormalizer({
                    getTarget: () => ({ sessionId: destination.id, hasPendingProviderInput: localId => deliveries.some(row => row.localInputId === localId),
                        observeProviderInputSettlement: ({ localId }) => {
                            const settlement = beforeSettlement.then(() => settleAcceptance(localId)).then(() => false);
                            settlements.push(settlement);
                            return settlement;
                        } }),
                    observeAcceptedEffect: (localId, pendingSettlement) => prepared.acknowledgeAccepted({ kind: 'admitted_input', localInputId: localId,
                        userMessageSeq: deliveries.find(row => row.localInputId === localId)!.userMessageSeq }, pendingSettlement),
                });
                for (const localId of prepared.representedFollowLocalInputIds ?? []) observe({ type: 'input-accepted', localId,
                    userMessageSeq: deliveries.find(row => row.localInputId === localId)!.userMessageSeq,
                    delivery: { kind: 'followUp', turnId: 'receiver-turn' } });
                return Promise.all(settlements);
            };
            const accept = async (prepared: PreparedContext) => {
                expect(await prepared.recheckAdmission(new AbortController().signal)).toBe(true);
                acceptedPrompts.push(renderSessionInputContextPromptV1({ transformedUserText: '',
                    sessionFollowUpdates: prepared.updates, workerUpdates: prepared.workerUpdates }));
                const before = acknowledgements.length;
                for (const localId of prepared.representedFollowLocalInputIds ?? []) {
                    const delivery = deliveries.find(row => row.localInputId === localId)!;
                    await settleAcceptance(localId);
                    prepared.acknowledgeAccepted({ kind: 'admitted_input', localInputId: localId, userMessageSeq: delivery.userMessageSeq });
                }
                await vi.waitFor(() => expect(acknowledgements.length).toBe(before + (prepared.representedFollowLocalInputIds?.length ?? 0)));
                await Promise.allSettled(acknowledgements);
            };
            return { prepare, accept, acceptNative, settleAcceptance, replacePublisher, deliveries, restart, dispatchPending,
                dispatchReceiverPending, admissionFault, rulesReadBarrier, requests, sourceChanged, recoveries };
        };
        const appendReply = async (text: string, turnId: string) => {
            await appendTurnInput(turnId);
            const seq = (await db.session.findUniqueOrThrow({ where: { id: source.id } })).seq + 1;
            await db.sessionMessage.create({ data: { sessionId: source.id, seq, localId: randomUUID(), messageRole: 'agent',
                content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: text } } } },
                transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
            await db.session.update({ where: { id: source.id }, data: { seq, latestTurnId: turnId, latestTurnStatus: 'completed' } });
            return seq;
        };
        const appendReport = async (summary: string, deliverables?: WorkerUpdateV1['deliverables']) => {
            const seq = (await db.session.findUniqueOrThrow({ where: { id: source.id } })).seq + 1;
            const localId = randomUUID();
            await db.sessionMessage.create({ data: { sessionId: source.id, seq, localId, messageRole: 'event',
                content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: localId,
                    data: TranscriptRawAgentEventV1Schema.parse({ type: 'worker-report', summary,
                        deliverables: deliverables ?? [{ kind: 'workspace_file', sessionId: source.id, path: `report-${seq}.md` }] }) } } },
                transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
            await db.session.update({ where: { id: source.id }, data: { seq } });
            return seq;
        };
        return { account, authentication, hydrateOptions, source, destination, observe, wake, makeReconciler, offline, acknowledgements, advanceTranscript,
            commitWorkerWake, ackTransport, follow, detachManager, originals, appendReply, appendReport, appendTurnInput, acceptedPrompts };
    }

    it.each(['pending acceptance', 'publisher replacement', 'unverified acceptance'] as const)('settles an accepted original after %s without native replay', async failure => {
        const f = await fixture();
        await f.follow({ preset: 'quiet' });
        const prefix = await f.appendReport('Held original before Resume');
        const intake = await f.originals(true);
        const prepared = await intake.prepare('natural');
        expect(prepared?.representedFollowLocalInputIds).toHaveLength(1);
        expect(await prepared!.recheckAdmission(new AbortController().signal)).toBe(true);
        // A reconnect/Resume can replace publisher registration after preparation
        // while the exact admitted input is accepted by the native provider.
        if (failure === 'publisher replacement') await intake.replacePublisher();
        if (failure === 'unverified acceptance') {
            const localId = prepared!.representedFollowLocalInputIds![0]!;
            prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId: localId,
                userMessageSeq: intake.deliveries.find(row => row.localInputId === localId)!.userMessageSeq });
            await vi.waitFor(() => expect(f.acknowledgements).toHaveLength(1));
            expect(await f.acknowledgements[0]).toMatchObject({ ok: false, error: 'provider_acceptance_unverified' });
            await intake.settleAcceptance(localId);
            await intake.replacePublisher();
            expect(await intake.prepare('natural')).toBeNull();
            expect(f.acknowledgements).toHaveLength(2);
            expect(await f.acknowledgements[1]).toMatchObject({ ok: true });
            expect(await db.sessionMessage.count({ where: { sessionId: f.destination.id, messageRole: 'user' } })).toBe(1);
            return;
        }
        const suffix = failure === 'publisher replacement' ? await f.appendReport('Later original remains separate') : null;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const settlement = intake.acceptNative(prepared!, gate);
        const beforeSettlement = f.acknowledgements.length;
        release();
        await settlement;
        await vi.waitFor(() => expect(f.acknowledgements).toHaveLength(1));
        await Promise.allSettled(f.acknowledgements);
        if (failure === 'pending acceptance') expect(beforeSettlement).toBe(0);
        expect(await f.acknowledgements[0]).toMatchObject({ ok: true });
        for (const edge of await db.sessionFollowEdge.findMany({ where: { destinationSessionId: f.destination.id } })) {
            expect(edge.deliveredTranscriptSeq).toBe(prefix);
        }
        expect(f.acceptedPrompts).toHaveLength(1);
        expect(await db.sessionMessage.count({ where: { sessionId: f.destination.id, messageRole: 'user' } })).toBe(1);
        const next = await intake.prepare('natural');
        if (suffix === null) expect(next).toBeNull();
        else {
            expect(next?.representedFollowLocalInputIds).toHaveLength(1);
            expect(next!.representedFollowLocalInputIds![0]).not.toBe(prepared!.representedFollowLocalInputIds![0]);
            await intake.accept(next!);
            expect(await f.acknowledgements.at(-1)).toMatchObject({ ok: true });
            for (const edge of await db.sessionFollowEdge.findMany({ where: { destinationSessionId: f.destination.id } })) {
                expect(edge.deliveredTranscriptSeq).toBe(suffix);
            }
            expect(f.acceptedPrompts).toHaveLength(2);
            expect(await intake.prepare('natural')).toBeNull();
        }
    });

    it('rejoins an accepted ready original after the host sealed its Turn anchors', async () => {
        const f = await fixture();
        await f.follow({ preset: 'everything' });
        await db.sessionTurn.create({ data: { sessionId: f.source.id, turnId: 'worker-turn', status: 'completed',
            startedAt: 1n, updatedAt: 2n, terminalAt: 2n,
            transcriptAnchorsJson: JSON.stringify({ startSeqInclusive: 1, endSeqInclusive: 1 }) } });
        const readyLocalId = randomUUID();
        await db.sessionMessage.create({ data: { sessionId: f.source.id, seq: 2, localId: readyLocalId, messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: readyLocalId,
                data: TranscriptRawAgentEventV1Schema.parse({ type: 'ready', completedTurnId: 'worker-turn' }) } } },
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
        await db.session.update({ where: { id: f.source.id }, data: { seq: 2, latestTurnStatus: 'completed', latestReadyEventSeq: 2 } });
        const intake = await f.originals();
        const prepared = await intake.prepare('natural');
        expect(prepared?.representedFollowLocalInputIds).toHaveLength(1);
        expect(prepared?.workerUpdates ?? []).toEqual([]);
        f.ackTransport.beforeAcknowledge = async () => { throw new Error('Original ACK unavailable'); };
        await intake.accept(prepared!);
        // Removing one captured intent does not erase actual acceptance. The
        // current manager still grants source/pair access for exact rejoin.
        await db.sessionFollowEdge.delete({ where: { destinationSessionId_sourceSessionId_relation: {
            destinationSessionId: f.destination.id, sourceSessionId: f.source.id, relation: 'follower',
        } } });
        await db.sessionFollowEdge.update({ where: { managerSourceSessionId: f.source.id }, data: { deliveredTranscriptSeq: 2 } });
        expect(await f.makeReconciler()({ signal: new AbortController().signal, deliveryIntent: 'natural' })).toBeNull();
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.destination.id } })).toBe(0);
        expect(await db.sessionMessage.count({ where: { sessionId: f.destination.id, messageRole: 'user' } })).toBe(1);
        // An accepted older ready is not evidence for another completed Turn.
        await db.sessionTurn.create({ data: { sessionId: f.source.id, turnId: 'other-turn', status: 'completed',
            startedAt: 3n, updatedAt: 4n, terminalAt: 4n,
            transcriptAnchorsJson: JSON.stringify({ startSeqInclusive: 1, endSeqInclusive: 1 }) } });
        await db.session.update({ where: { id: f.source.id }, data: { latestTurnId: 'other-turn' } });
        expect((await f.makeReconciler()({ signal: new AbortController().signal, deliveryIntent: 'natural' }))?.workerUpdates)
            .toMatchObject([{ ownerState: 'settled' }]);
        await db.session.update({ where: { id: f.source.id }, data: { latestTurnId: 'worker-turn', archivedAt: new Date() } });
        expect((await f.observe()).observations).toEqual([]);
        await db.session.update({ where: { id: f.source.id }, data: { archivedAt: null } });
        await f.appendReport('The later original still arrives');
        const later = await intake.prepare('natural');
        expect(later?.workerUpdates).toMatchObject([{ ownerState: 'published', result: 'The later original still arrives' }]);
        expect(later?.representedFollowLocalInputIds).toHaveLength(1);
    });

    it('carries selected Account Voice originals from real observation through accepted prefix ACK, keeping the initial snapshot distinct', async () => {
        const f = await fixture();
        await db.session.update({ where: { id: f.destination.id }, data: { tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } });
        const runtimeAuthority = { executionRunId: 'voice-run', occurrenceId: 'voice-occurrence',
            parentSessionId: f.destination.id, intent: 'voice_agent' as const, runtimeState: 'active_turn' as const };
        const policy: FollowPolicyV1 = { preset: 'custom', events: {
            update_posted: { delivery: 'quiet', voice: true }, goal_changed: { delivery: 'quiet', voice: false },
            message: { delivery: 'off', voice: true },
        } };
        expect(await setAccountSessionFollow({ accountId: f.account.id, sessionId: f.source.id,
            authentication: f.authentication, preferences: { policy } })).toMatchObject({ ok: true });
        const acknowledgements: Array<Promise<unknown>> = [];
        const session = { ...f.hydrateOptions.session,
            observePendingAccountVoiceFollow: async () => AccountVoiceFollowObservePendingResponseV1Schema.parse({
                ok: true, v: 1, voiceSessionId: f.destination.id, publisherGeneration: '1', executionRunOccurrenceId: runtimeAuthority.occurrenceId,
                observations: await inTx(tx => observePendingAccountVoiceFollowInTx(tx, {
                    accountId: f.account.id, voiceSessionId: f.destination.id, authentication: f.authentication, runtimeAuthority,
                })),
            }),
            acknowledgeAccountVoiceFollow: (request: Omit<AccountVoiceFollowAcknowledgeRequestV1, 'v' | 'voiceSessionId'>) => {
                const parsed = AccountVoiceFollowAcknowledgeRequestV1Schema.parse({ ...request, v: 1, voiceSessionId: f.destination.id });
                const acknowledgement = inTx(tx => acknowledgeAccountVoiceFollowInTx(tx, { ...parsed,
                    accountId: f.account.id, authentication: f.authentication, runtimeAuthority }));
                acknowledgements.push(acknowledgement);
                return acknowledgement;
            },
        };
        const hydrateOptions = { ...f.hydrateOptions, session, disclosure: { level: 'snippets' as const,
            shareRecentMessages: true, shareSessionSummary: true, includeUserMessagesInSnippets: true, snippetsMaxMessages: 1 } };
        const { createSessionFollowSourceHydrator } = await vi.importActual<{
            createSessionFollowSourceHydrator: (options: typeof hydrateOptions) => (input: {
                observation: SessionFollowPendingObservationV1; signal: AbortSignal;
                readMode?: 'incremental' | 'initial_current_snapshot'; selectionChannel?: 'voice';
            }) => Promise<SessionFollowUpdateEnvelopeV1 | null>;
        }>('../../../../../cli/src/agent/runtime/session/follow/sessionFollowSourceHydrator');
        const hydrateObservation = createSessionFollowSourceHydrator(hydrateOptions);
        const { createSessionFollowContextReconciler } = await vi.importActual<{
            createSessionFollowContextReconciler: (options: { session: typeof session; hydrateObservation: typeof hydrateObservation;
                maxFollowContextUtf8Bytes: number; observer: { kind: 'account_voice'; accountId: string; voiceSessionId: string } }) =>
                (input: { signal: AbortSignal; executionRunId: string }) => Promise<{
                    updates: readonly SessionFollowUpdateEnvelopeV1[];
                    recheckAdmission: (signal: AbortSignal) => Promise<boolean>;
                    acknowledgeAccepted: (input: { kind: 'admitted_input'; localInputId: string; userMessageSeq: number }) => void;
                } | null>;
        }>('../../../../../cli/src/agent/runtime/session/follow/sessionFollowContextReconciler');
        const reconcile = createSessionFollowContextReconciler({ session, hydrateObservation, maxFollowContextUtf8Bytes: 8192,
            observer: { kind: 'account_voice', accountId: f.account.id, voiceSessionId: f.destination.id } });
        const prepare = () => reconcile({ signal: new AbortController().signal, executionRunId: runtimeAuthority.executionRunId });
        const accept = async (prepared: NonNullable<Awaited<ReturnType<typeof prepare>>>) => {
            expect(await prepared.recheckAdmission(new AbortController().signal)).toBe(true);
            const seq = await db.sessionMessage.count({ where: { sessionId: f.destination.id } }) + 1;
            const localInputId = randomUUID();
            await db.sessionMessage.create({ data: { sessionId: f.destination.id, seq, localId: localInputId, messageRole: 'user',
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Continue Voice' } } } } });
            prepared.acknowledgeAccepted({ kind: 'admitted_input', localInputId, userMessageSeq: seq });
            await vi.waitFor(() => expect(acknowledgements.length).toBe(seq));
            expect(await acknowledgements.at(-1)).toMatchObject({ ok: true });
        };
        const initial = await prepare();
        expect(initial?.updates[0]?.recentMessages.map(message => message.seq)).toEqual([1]);
        expect(acknowledgements).toEqual([]);
        await accept(initial!);
        const originals = [
            { type: 'text', text: 'Unselected ordinary message' },
            { type: 'event', data: TranscriptRawAgentEventV1Schema.parse({ type: 'goal-changed' }) },
            { type: 'event', data: TranscriptRawAgentEventV1Schema.parse({ type: 'worker-report', summary: 'First selected original' }) },
            { type: 'event', data: TranscriptRawAgentEventV1Schema.parse({ type: 'worker-report', summary: 'Second selected original' }) },
        ];
        for (const [index, content] of originals.entries()) {
            await db.sessionMessage.create({ data: { sessionId: f.source.id, seq: index + 2, localId: randomUUID(), messageRole: 'agent',
                content: { t: 'plain', v: { role: 'agent', content } } } });
        }
        await db.session.update({ where: { id: f.source.id }, data: { seq: 5 } });
        const first = await prepare();
        expect(first?.updates[0]?.recentMessages.map(message => message.seq)).toEqual([4]);
        expect(first?.updates[0]?.observed.transcriptSeq).toBe(4);
        expect(first?.updates[0]?.truncated).toBe(true);
        expect(acknowledgements).toHaveLength(1);
        await accept(first!);
        const second = await prepare();
        expect(second?.updates[0]?.recentMessages.map(message => message.seq)).toEqual([5]);
        expect(second?.updates[0]?.observed.transcriptSeq).toBe(5);
        await setAccountSessionFollow({ accountId: f.account.id, sessionId: f.source.id,
            authentication: f.authentication, preferences: { policy: { preset: 'custom', events: {
                goal_changed: { delivery: 'quiet', voice: true },
            } } } });
        expect(await second!.recheckAdmission(new AbortController().signal)).toBe(false);
        expect(acknowledgements).toHaveLength(2);
        await setAccountSessionFollow({ accountId: f.account.id, sessionId: f.source.id,
            authentication: f.authentication, preferences: { policy: { preset: 'custom', events: {
                stalled: { delivery: 'quiet', voice: true },
            } } } });
        expect(await f.offline()).toMatchObject([{ status: 'expired' }]);
        expect((await db.session.findUniqueOrThrow({ where: { id: f.source.id } })).seq).toBe(5);
        const stalled = await prepare();
        expect(stalled?.updates[0]).toMatchObject({ recentMessages: [], observed: { transcriptSeq: 5,
            turn: { id: 'worker-turn', status: 'stalled' } } });
        await db.session.update({ where: { id: f.source.id }, data: { active: true } });
        expect(await stalled!.recheckAdmission(new AbortController().signal)).toBe(false);
        expect(acknowledgements).toHaveLength(2);
    });

    it('uses stored Important policy for real completion/failure and withdraws a prepared wake after a policy-only edit', async () => {
        const f = await fixture('in_progress', { preset: 'important' });
        await f.appendReply('Finished quietly', 'policy-turn');
        expect(await f.wake()).toBeNull();
        const natural = await f.makeReconciler()({ signal: new AbortController().signal, deliveryIntent: 'natural' });
        expect(natural?.workerUpdates).toMatchObject([{ ownerState: 'settled', result: 'Finished quietly' }]);
        await db.session.update({ where: { id: f.source.id }, data: { latestTurnStatus: 'failed' } });
        const failed = await f.wake();
        expect(failed?.workerUpdates).toMatchObject([{ ownerState: 'failed' }]);
        await db.sessionFollowEdge.update({ where: { managerSourceSessionId: f.source.id },
            data: { policyJson: serializeFollowPolicyV1({ preset: 'quiet' }) } });
        expect(await failed!.recheckAdmission(new AbortController().signal)).toBe(false);
        expect(await f.wake()).toBeNull();
    });

    it.each(['natural', 'wake'] as const)('merges the same original through manager and explicit Follow on %s intake and ACKs both routes', async (intent) => {
        const f = await fixture();
        await f.follow();
        const original = await f.originals();
        await f.appendReport('Occurrence A');
        const prepared = await original.prepare(intent);
        expect(prepared).not.toBeNull();
        expect(prepared?.workerUpdates).toMatchObject([{ result: 'Occurrence A',
            deliverables: [{ kind: 'workspace_file', sessionId: f.source.id, path: 'report-2.md' }] }]);
        await original.accept(prepared!);
        expect(f.acceptedPrompts[0]!.split('Occurrence A')).toHaveLength(2);
        expect(await Promise.all(f.acknowledgements)).toEqual([
            expect.objectContaining({ ok: true }),
        ]);
        expect((await f.observe()).observations).toEqual([]);
        expect(await original.prepare(intent)).toBeNull();
        expect(await db.sessionMessage.count({ where: { sessionId: f.destination.id, acceptedTurnId: 'receiver-turn' } })).toBe(1);
    });

    it.each([
        ['natural', 'person_wrote'], ['wake', 'person_wrote'],
        ['natural', 'goal_changed'], ['wake', 'goal_changed'],
    ] as const)('accepts one %s direction notice for %s and settles both manager and ordinary routes', async (intent, eventKind) => {
        const f = await fixture('in_progress', { preset: 'custom', events: { [eventKind]: { delivery: 'interrupt' } } });
        await f.follow({ preset: 'quiet' });
        const original = await f.originals();
        const localId = randomUUID();
        const human = buildTrustedHostSessionInputAdmissionV1('ui');
        const receipt = { v: 1 as const, issuer: 'authenticatedAccount' as const,
            actorAccountId: f.account.id, sessionRelationship: 'owner' as const };
        await db.sessionMessage.create({ data: { sessionId: f.source.id, seq: 2, localId,
            messageRole: eventKind === 'goal_changed' ? 'agent' : 'user',
            ...(eventKind === 'person_wrote' ? { inputAdmissionReceipt: receipt } : {}),
            content: { t: 'plain', v: eventKind === 'goal_changed'
                ? { role: 'agent', content: { type: 'event', id: localId, data: TranscriptRawAgentEventV1Schema.parse({ type: 'goal-changed' }) } }
                : { role: 'user', content: { type: 'text', text: 'Private source direction' },
                    meta: {
                        happierInputAuthorityV1: settleSessionInputRequestV1({ request: human.request,
                            currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt }),
                        happierProvenanceV1: settleSessionMessageProvenanceV1({ request: human.request,
                            requestedProvenance: human.provenance, inputAdmissionReceipt: receipt }),
                    } } },
        } });
        await db.session.update({ where: { id: f.source.id }, data: { seq: 2 } });
        const prepared = await original.prepare(intent);
        expect(prepared?.updates).toHaveLength(1);
        expect(prepared!.updates[0]!.recentMessages).toHaveLength(1);
        expect(prepared!.updates[0]!.recentMessages[0]).toMatchObject({ seq: 2,
            ...(eventKind === 'goal_changed' ? { event: { kind: 'goal_changed' } } : { provenance: { kind: 'happierApp' } }) });
        expect(prepared!.workerUpdates).toBeUndefined();
        await original.accept(prepared!);
        expect(f.acceptedPrompts[0]).not.toContain('Private source direction');
        expect(await Promise.all(f.acknowledgements)).toEqual([
            expect.objectContaining({ ok: true, delivered: expect.objectContaining({ transcriptSeq: 2 }) }),
        ]);
        expect((await f.observe()).observations).toEqual([]);
    });

    it('retries an accepted original ACK at the next boundary without materializing or accepting it again', async () => {
        const f = await fixture();
        await f.follow();
        const original = await f.originals();
        await f.appendReport('Accepted original awaiting progress');
        const prepared = await original.prepare('natural');
        expect(prepared?.representedFollowLocalInputIds).toHaveLength(1);
        f.ackTransport.retryable = true;
        await original.accept(prepared!);
        expect(await f.acknowledgements[0]).toMatchObject({ ok: false, error: 'retryable' });
        expect(await original.prepare('natural')).toBeNull();
        expect(f.acknowledgements).toHaveLength(2);
        f.ackTransport.retryable = false;
        expect(await original.prepare('natural')).toBeNull();
        expect(f.acknowledgements).toHaveLength(3);
        expect(await f.acknowledgements[2]).toMatchObject({ ok: true });
        expect((await f.observe()).observations).toEqual([]);
        expect(f.acceptedPrompts).toHaveLength(1);
        expect(await db.sessionMessage.count({ where: { sessionId: f.destination.id, acceptedTurnId: 'receiver-turn' } })).toBe(1);
    });

    it('rejoins accepted original custody after a pre-commit ACK failure, new occurrence, publisher restart and route change', async () => {
        const f = await fixture();
        await f.follow();
        const original = await f.originals();
        await f.appendReport('Occurrence A');
        const first = await original.prepare('natural');
        f.ackTransport.beforeAcknowledge = async () => { throw new Error('ACK transport failed before progress transaction'); };
        await original.accept(first!);
        await Promise.allSettled(f.acknowledgements);
        expect(await db.sessionMessage.count({ where: { sessionId: f.destination.id, acceptedTurnId: 'receiver-turn' } })).toBe(1);
        const secondSeq = await f.appendReport('Occurrence B');
        await db.session.update({ where: { id: f.destination.id }, data: { publisherGeneration: 2n } });
        await f.detachManager();
        await f.follow({ preset: 'everything' });
        expect(await first!.recheckAdmission(new AbortController().signal)).toBe(false);
        f.ackTransport.beforeAcknowledge = async () => {};
        original.restart();
        const restarted = await original.prepare('natural');
        await original.accept(restarted!);
        expect(f.acceptedPrompts.map(prompt => prompt.split('Occurrence A').length - 1)).toEqual([1, 0]);
        expect(f.acceptedPrompts.map(prompt => prompt.split('Occurrence B').length - 1)).toEqual([0, 1]);
        expect(await Promise.all(f.acknowledgements.slice(1))).toEqual([
            expect.objectContaining({ ok: true, delivered: expect.objectContaining({ transcriptSeq: secondSeq }) }),
        ]);
        expect((await f.observe()).observations).toEqual([]);
        expect(await original.prepare('natural')).toBeNull();
        expect(await db.sessionMessage.count({ where: { sessionId: f.destination.id, acceptedTurnId: 'receiver-turn' } })).toBe(2);
    });

    it.each([
        { entry: 'receiver', boundary: 'admission' }, { entry: 'receiver', boundary: 'routes' },
        { entry: 'source', boundary: 'admission' }, { entry: 'source', boundary: 'routes' },
    ] as const)('retains the earlier held original after a $boundary failure through $entry admission instead of accepting its later suffix on Resume', async ({ entry, boundary }) => {
        const f = await fixture();
        await f.detachManager();
        await f.follow({ preset: 'custom', events: { update_posted: { delivery: 'interrupt' } } });
        const original = await f.originals(false, entry);
        const receiver = await db.session.findUniqueOrThrow({ where: { id: f.destination.id } });
        const metadata = writeSessionExplicitStopV1ToMetadata(JSON.parse(receiver.metadata), {
            v: 1, cause: 'explicit_stop', requestId: 'person-stop', requestedAtMs: 1,
        });
        await db.session.update({ where: { id: f.destination.id }, data: { active: false, metadata: JSON.stringify(metadata) } });
        const firstSeq = await f.appendReport('Held reverseA');
        const secondSeq = await f.appendReport('Held reverseB');
        original.admissionFault.originalSeq = firstSeq;
        original.admissionFault.boundary = boundary;
        await original.dispatchPending();
        expect(f.acceptedPrompts).toEqual([]);
        await db.session.update({ where: { id: f.destination.id }, data: { active: true,
            metadata: JSON.stringify(clearSessionExplicitStopV1FromMetadata(metadata, 'person-stop')) } });
        original.restart();
        await original.replacePublisher();
        const blocked = await original.prepare('wake');
        if (blocked) await original.accept(blocked);
        expect(await db.sessionFollowEdge.findMany({ where: { destinationSessionId: f.destination.id },
            select: { deliveredTranscriptSeq: true } })).toEqual([{ deliveredTranscriptSeq: firstSeq - 1 }]);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.destination.id } })).toBe(0);
        expect(f.acceptedPrompts).toEqual([]);
        expect((await f.observe()).observations).toEqual([
            expect.objectContaining({ delivered: expect.objectContaining({ transcriptSeq: firstSeq - 1 }) }),
        ]);
        original.admissionFault.originalSeq = null;
        const first = await original.prepare('wake');
        expect(first?.workerUpdates).toMatchObject([{ result: 'Held reverseA', transcriptPointer: { seq: firstSeq } }]);
        await original.accept(first!);
        const second = await original.prepare('wake');
        expect(second?.workerUpdates).toMatchObject([{ result: 'Held reverseB', transcriptPointer: { seq: secondSeq } }]);
        await original.accept(second!);
        expect(f.acceptedPrompts.map(prompt => [prompt.includes('Held reverseA'), prompt.includes('Held reverseB')]))
            .toEqual([[true, false], [false, true]]);
        expect((await f.observe()).observations).toEqual([]);
    });

    it('does not let a manager terminal fallback consume an unadmitted report', async () => {
        const f = await fixture();
        const original = await f.originals(true);
        const reportSeq = await f.appendReport('Original report remains unadmitted');
        await f.appendReply('Later source completion', 'completed-after-report');
        original.admissionFault.originalSeq = reportSeq;
        await original.dispatchPending();
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.destination.id } })).toBe(0);
        const legacyReconcile = f.makeReconciler();
        const terminal = await f.wake(legacyReconcile);
        if (terminal) {
            await f.commitWorkerWake(terminal);
            terminal.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: terminal.wakeEventLocalId! });
            await vi.waitFor(() => expect(f.acknowledgements).toHaveLength(1));
            await Promise.all(f.acknowledgements);
        }
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id))).toMatchObject({ deliveredTranscriptSeq: reportSeq - 1 });
        original.admissionFault.originalSeq = null;
        const recovered = await original.prepare('natural', 8192);
        expect(recovered?.representedFollowLocalInputIds).toHaveLength(1);
        expect(recovered?.workerUpdates).toMatchObject([{ ownerState: 'published', result: 'Original report remains unadmitted' }]);
        await original.accept(recovered!);
        const finalOriginal = await original.prepare('natural', 8192);
        expect(finalOriginal?.representedFollowLocalInputIds).toHaveLength(1);
        await original.accept(finalOriginal!);
        expect(f.acceptedPrompts[1]).toContain('Later source completion');
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id))).toMatchObject({ deliveredTranscriptSeq: 4 });
        expect((await f.wake(legacyReconcile))?.workerUpdates).toMatchObject([{ ownerState: 'settled' }]);
    });

    it.each(['receiver', 'source'] as const)('preserves the CONT14 originals 7–11 and private deliverable across held publisher replacement and bounded intake (%s)', async entry => {
        const f = await fixture('in_progress', { preset: 'important' });
        for (let index = 0; index < 5; index++) await f.appendTurnInput(`earlier-turn-${index}`);
        await f.follow({ preset: 'quiet' });
        const original = await f.originals(true, entry);
        const receiver = await db.session.findUniqueOrThrow({ where: { id: f.destination.id } });
        const held = writeSessionExplicitStopV1ToMetadata(JSON.parse(receiver.metadata), {
            v: 1, cause: 'explicit_stop', requestId: 'cont14-person-stop', requestedAtMs: 1,
        });
        await db.session.update({ where: { id: f.destination.id }, data: { active: false, metadata: JSON.stringify(held) } });
        const artifactId = randomUUID();
        const summaries = ['Quiet', 'A'.repeat(2479), 'B'.repeat(2479), 'Report A', 'Report B'];
        const seqs: number[] = [];
        for (const [index, summary] of summaries.entries()) seqs.push(await f.appendReport(summary,
            index === 3 ? [{ kind: 'artifact', artifactId }] : []));
        expect(seqs).toEqual([7, 8, 9, 10, 11]);
        await original.dispatchPending();
        expect(f.acceptedPrompts).toEqual([]);
        expect(f.acknowledgements).toEqual([]);
        await db.session.update({ where: { id: f.destination.id }, data: { active: true,
            metadata: JSON.stringify(clearSessionExplicitStopV1FromMetadata(held, 'cont14-person-stop')) } });
        await original.replacePublisher();
        original.restart();
        const prefix = await original.prepare('natural', 4096, true);
        expect(original.deliveries).toHaveLength(5);
        expect(prefix?.workerUpdates?.map(update => update.transcriptPointer?.kind === 'session' ? update.transcriptPointer.seq : null))
            .toEqual([7, 8]);
        await original.accept(prefix!);
        expect(f.acceptedPrompts[0]).not.toContain('Report B');
        expect(f.acceptedPrompts[0]).not.toContain(artifactId);
        // Each ACK reobserves publisher custody independently. Its request order
        // need not match representation order; durable progress must not regress.
        const prefixAcknowledgements = await Promise.all(f.acknowledgements);
        expect(prefixAcknowledgements).toHaveLength(2);
        expect(prefixAcknowledgements).toEqual(expect.arrayContaining([
            expect.objectContaining({ ok: true, delivered: expect.objectContaining({ transcriptSeq: 7 }) }),
            expect.objectContaining({ ok: true, delivered: expect.objectContaining({ transcriptSeq: 8 }) }),
        ]));
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id)))
            .toMatchObject({ deliveredTranscriptSeq: 8 });
        const suffixIds = original.deliveries.slice(2).map(row => row.localInputId);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.destination.id, localId: { in: suffixIds } } })).toBe(3);
        const suffix = await original.prepare('natural', 8192, true);
        expect(suffix?.representedFollowLocalInputIds).toEqual(suffixIds);
        expect(suffix?.workerUpdates?.map(update => update.transcriptPointer?.kind === 'session' ? update.transcriptPointer.seq : null))
            .toEqual([9, 10, 11]);
        expect(suffix?.workerUpdates?.[1]?.deliverables).toEqual([{ kind: 'artifact', artifactId }]);
        await original.accept(suffix!);
        expect(f.acceptedPrompts[1]!.indexOf('Report A')).toBeLessThan(f.acceptedPrompts[1]!.indexOf('Report B'));
        expect(f.acceptedPrompts[1]).toContain(artifactId);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.destination.id } })).toBe(0);
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id)))
            .toMatchObject({ deliveredTranscriptSeq: 11 });
        expect((await f.observe()).observations).toEqual([]);
    });

    it('recovers the CONT16 persisted 8–11 suffix after accepting only original 7 under the successor without replaying source notifications', async () => {
        const f = await fixture('in_progress', { preset: 'quiet' });
        for (let index = 0; index < 5; index++) await f.appendTurnInput(`earlier-turn-${index}`);
        await f.follow({ preset: 'quiet' });
        const original = await f.originals(true, 'source');
        const receiver = await db.session.findUniqueOrThrow({ where: { id: f.destination.id } });
        const held = writeSessionExplicitStopV1ToMetadata(JSON.parse(receiver.metadata), {
            v: 1, cause: 'explicit_stop', requestId: 'cont16-person-stop', requestedAtMs: 1,
        });
        await db.session.update({ where: { id: f.destination.id }, data: { active: false, metadata: JSON.stringify(held) } });
        expect(await f.appendReport('ORC_LIVE_CONT16_QUIET_7', [])).toBe(7);
        await original.dispatchPending();
        const olderObservations = (await f.observe()).observations;
        const artifactId = randomUUID();
        for (const [index, summary] of ['A'.repeat(2479), 'B'.repeat(2479), 'Report A', 'Report B'].entries()) {
            expect(await f.appendReport(summary, index === 2 ? [{ kind: 'artifact', artifactId }] : [])).toBe(index + 8);
        }
        // A lost source notification cannot require reposting an already committed
        // original. Only 7 has Pending custody when the successor first prepares.
        original.admissionFault.originalSeq = 8;
        original.admissionFault.boundary = 'routes';
        await db.session.update({ where: { id: f.destination.id }, data: { active: true,
            metadata: JSON.stringify(clearSessionExplicitStopV1FromMetadata(held, 'cont16-person-stop')) } });
        await original.replacePublisher();
        original.restart();
        const prefix = await original.prepare('natural', 4096, true, 'receiver');
        expect(original.deliveries.map(row => 'sourceMessage' in row.delivery.original ? row.delivery.original.sourceMessage.seq : null)).toEqual([7]);
        expect(prefix?.workerUpdates?.map(update => update.transcriptPointer?.kind === 'session' ? update.transcriptPointer.seq : null)).toEqual([7]);
        await original.accept(prefix!);
        expect(await Promise.all(f.acknowledgements)).toEqual([
            expect.objectContaining({ ok: true, delivered: expect.objectContaining({ transcriptSeq: 7 }) }),
        ]);
        original.admissionFault.originalSeq = null;
        // Source notifications and receiver recovery share the captured Account
        // cache. A delayed 7-only notification must not retire a concurrent range
        // that has already observed all persisted originals through 11.
        let releaseRules!: () => void;
        const rulesGate = new Promise<void>(resolve => { releaseRules = resolve; });
        let readingRules = false;
        original.rulesReadBarrier.beforeRead = async () => { readingRules = true; await rulesGate; };
        const listsBefore = original.requests.filter(request => request.url.endsWith('/follows/sessions')).length;
        const newestRecovery = original.dispatchReceiverPending();
        await vi.waitFor(() => expect(readingRules).toBe(true));
        const olderRecovery = original.dispatchReceiverPending(olderObservations);
        try {
            await vi.waitFor(() => expect(original.requests.filter(request => request.url.endsWith('/follows/sessions')).length)
                .toBe(listsBefore + 2));
        } finally { releaseRules(); }
        await Promise.all([newestRecovery, olderRecovery]);
        original.rulesReadBarrier.beforeRead = undefined;
        const suffix = await original.prepare('natural', 16384, true, 'admitted');
        expect(suffix?.workerUpdates?.map(update => update.transcriptPointer?.kind === 'session' ? update.transcriptPointer.seq : null))
            .toEqual([8, 9, 10, 11]);
        expect(suffix?.workerUpdates?.[2]?.deliverables).toEqual([{ kind: 'artifact', artifactId }]);
        await original.accept(suffix!);
        expect(f.acceptedPrompts[1]).toContain(artifactId);
        const suffixAcknowledgements = await Promise.all(f.acknowledgements.slice(1));
        expect(suffixAcknowledgements).toHaveLength(4);
        expect(suffixAcknowledgements).toEqual(expect.arrayContaining([8, 9, 10, 11].map(transcriptSeq =>
            expect.objectContaining({ ok: true, delivered: expect.objectContaining({ transcriptSeq }) }))));
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id)))
            .toMatchObject({ deliveredTranscriptSeq: 11 });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.destination.id } })).toBe(0);
        expect((await f.observe()).observations).toEqual([]);
    });

    it.each(['receiver change', 'reconnect'] as const)('recovers CONT18 originals 9–11 on %s after middle admission timeout and prefix ACK', async event => {
        const f = await fixture('in_progress', { preset: 'quiet' });
        for (let index = 0; index < 5; index++) await f.appendTurnInput(`earlier-turn-${index}`);
        await f.follow({ preset: 'quiet' });
        await db.sessionFollowEdge.updateMany({ where: { sourceSessionId: f.source.id, destinationSessionId: f.destination.id },
            data: writeSessionFollowFrontierColumns(readCurrentSourceSessionFollowFrontier(
                await db.session.findUniqueOrThrow({ where: { id: f.source.id } }))) });
        const original = await f.originals(true, 'source');
        const artifactId = randomUUID();
        for (const [index, summary] of ['Quiet 7', 'A'.repeat(2479), 'B'.repeat(2479), 'Report A', 'Report B'].entries()) {
            expect(await f.appendReport(summary, index === 3 ? [{ kind: 'artifact', artifactId }] : [])).toBe(index + 7);
        }
        original.admissionFault.timeoutAfterCommitSeq = 8;
        await original.dispatchReceiverPending();
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.destination.id } })).toBe(2);
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id))).toMatchObject({ deliveredTranscriptSeq: 6 });
        // The unconfirmed HTTP reply does not undo custody. Resume accepts only
        // the 7/8 prefix, with no source notification or manual recovery pass.
        await original.replacePublisher();
        original.restart();
        const prefix = await original.prepare('natural', 4096, true, 'admitted');
        expect(prefix?.workerUpdates?.map(update => update.transcriptPointer?.kind === 'session' ? update.transcriptPointer.seq : null)).toEqual([7, 8]);
        expect(await prefix!.recheckAdmission(new AbortController().signal)).toBe(true);
        f.acceptedPrompts.push(renderSessionInputContextPromptV1({ transformedUserText: '',
            sessionFollowUpdates: prefix!.updates, workerUpdates: prefix!.workerUpdates }));
        for (const localId of prefix!.representedFollowLocalInputIds!) await original.settleAcceptance(localId);
        const beforeAck = await db.accountChange.findFirstOrThrow({ where: { accountId: f.account.id,
            kind: 'session', entityId: f.destination.id } });
        for (const localId of prefix!.representedFollowLocalInputIds!) prefix!.acknowledgeAccepted({ kind: 'admitted_input',
            localInputId: localId, userMessageSeq: original.deliveries.find(row => row.localInputId === localId)!.userMessageSeq });
        await vi.waitFor(() => expect(f.acknowledgements).toHaveLength(2));
        expect(await Promise.all(f.acknowledgements)).toEqual([7, 8].map(transcriptSeq =>
            expect.objectContaining({ ok: true, delivered: expect.objectContaining({ transcriptSeq }) })));
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id))).toMatchObject({ deliveredTranscriptSeq: 8 });
        expect((await f.observe()).observations.length).toBeGreaterThan(0);
        const afterAck = await db.accountChange.findFirstOrThrow({ where: { accountId: f.account.id,
            kind: 'session', entityId: f.destination.id } });
        expect(afterAck.cursor).toBeGreaterThan(beforeAck.cursor);
        original.admissionFault.timeoutAfterCommitSeq = null;
        // A retired requester must not use a receiver hint as delivery authority.
        original.sourceChanged(f.destination.id, false);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.destination.id } })).toBe(0);
        if (event === 'receiver change') {
            original.admissionFault.originalSeq = 9;
            original.admissionFault.boundary = 'routes';
            original.sourceChanged(afterAck.entityId);
            await vi.waitFor(() => expect(original.recoveries).toHaveLength(1));
            await Promise.all(original.recoveries);
            expect(original.requests).toContainEqual({ url: `/v2/sessions/${f.source.id}/follows/occurrence-routes`, status: 503 });
            expect(await db.sessionPendingMessage.count({ where: { sessionId: f.destination.id } })).toBe(0);
            expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id))).toMatchObject({ deliveredTranscriptSeq: 8 });
            original.admissionFault.originalSeq = null;
        }
        const priorRecoveries = original.recoveries.length;
        original.sourceChanged(event === 'receiver change' ? afterAck.entityId : null);
        await vi.waitFor(() => expect(original.recoveries).toHaveLength(priorRecoveries + 1));
        await Promise.all(original.recoveries);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.destination.id } })).toBe(3);
        const suffix = await original.prepare('natural', 16384, true, 'admitted');
        expect(suffix?.workerUpdates?.map(update => update.transcriptPointer?.kind === 'session' ? update.transcriptPointer.seq : null)).toEqual([9, 10, 11]);
        expect(suffix?.workerUpdates?.[1]?.deliverables).toEqual([{ kind: 'artifact', artifactId }]);
        await original.accept(suffix!);
        expect(f.acceptedPrompts[1]).toContain(artifactId);
        const suffixAcknowledgements = await Promise.all(f.acknowledgements.slice(2));
        expect(suffixAcknowledgements).toHaveLength(3);
        expect(suffixAcknowledgements).toEqual(expect.arrayContaining([9, 10, 11].map(transcriptSeq =>
            expect.objectContaining({ ok: true, delivered: expect.objectContaining({ transcriptSeq }) }))));
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id))).toMatchObject({ deliveredTranscriptSeq: 11 });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.destination.id } })).toBe(0);
        expect((await f.observe()).observations).toEqual([]);
        // A repeated accepted ACK must not create an invalidation feedback loop.
        const settledChange = await db.accountChange.findFirstOrThrow({ where: { accountId: f.account.id,
            kind: 'session', entityId: f.destination.id } });
        const last = original.deliveries.at(-1)!;
        const frontiers = sessionFollowInputFrontiers(last.delivery);
        const publisherGeneration = (await db.session.findUniqueOrThrow({ where: { id: f.destination.id } })).publisherGeneration.toString();
        expect(await inTx(tx => acknowledgeAdmittedSessionFollowInputInTx(tx, {
            principal: { kind: 'destination_runtime', destinationRuntimeAccountId: f.account.id, authentication: f.authentication },
            request: { v: 1, destinationSessionId: f.destination.id, sourceSessionId: f.source.id, localInputId: last.localInputId,
                expectedPublisherGeneration: publisherGeneration,
                ...frontiers, consumed: frontiers.observed,
                acceptance: { kind: 'admitted_input', localInputId: last.localInputId, userMessageSeq: last.userMessageSeq } },
        }))).toMatchObject({ ok: true });
        expect((await db.accountChange.findFirstOrThrow({ where: { accountId: f.account.id,
            kind: 'session', entityId: f.destination.id } })).cursor).toBe(settledChange.cursor);
    });

    it('holds a budget-omitted original and its queued suffix, then accepts the exact prefix before the later report', async () => {
        const f = await fixture();
        await f.follow();
        const original = await f.originals();
        const firstSeq = await f.appendReport('First original A');
        await f.appendReport(`Later original B ${'detail '.repeat(300)}`);
        const full = await original.prepare('natural');
        expect(full?.representedFollowLocalInputIds).toHaveLength(1);
        // The real provider queue owns FIFO materialization. A missing context
        // budget must leave the current input unresolved and its suffix queued.
        const omitted = await original.prepare('natural', 1);
        expect(omitted?.representedFollowLocalInputIds ?? []).toEqual([]);
        expect(f.acceptedPrompts).toEqual([]);
        expect(f.acknowledgements).toEqual([]);
        expect(await db.sessionMessage.count({ where: { sessionId: f.destination.id } })).toBe(0);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: f.destination.id, status: 'queued' } })).toBe(2);
        const prefix = await original.prepare('natural');
        await original.accept(prefix!);
        expect(f.acceptedPrompts[0]).toContain('First original A');
        expect(f.acceptedPrompts[0]).not.toContain('Later original B');
        expect(await Promise.all(f.acknowledgements)).toEqual([
            expect.objectContaining({ ok: true, delivered: expect.objectContaining({ transcriptSeq: firstSeq }) }),
        ]);
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id)))
            .toMatchObject({ deliveredTranscriptSeq: firstSeq });
        const rest = await original.prepare('natural');
        await original.accept(rest!);
        expect(f.acceptedPrompts[1]).not.toContain('First original A');
        expect(f.acceptedPrompts[1]!.split('Later original B')).toHaveLength(2);
        expect(await Promise.all(f.acknowledgements.slice(1))).toEqual([
            expect.objectContaining({ ok: true }),
        ]);
        expect((await f.observe()).observations).toEqual([]);
    });

    it('delivers an original older than a source page before its later report and terminal outcome', async () => {
        const f = await fixture();
        await f.follow();
        const original = await f.originals();
        const firstSeq = await f.appendReport('Aged original finding');
        const count = SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1 + 1;
        await db.sessionMessage.createMany({ data: Array.from({ length: count }, (_, index) => ({
            sessionId: f.source.id, seq: firstSeq + index + 1, localId: randomUUID(), messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'codex',
                data: { type: 'token_count' } } } },
        })) });
        await db.session.update({ where: { id: f.source.id }, data: { seq: firstSeq + count } });
        const secondSeq = await f.appendReport('Later original finding');
        await f.appendReply('Actual later final result', 'later-turn');
        const prepared = await original.prepare('natural');
        expect(prepared?.workerUpdates).toMatchObject([{ ownerState: 'published', result: 'Aged original finding',
            deliverables: [{ kind: 'workspace_file', sessionId: f.source.id, path: `report-${firstSeq}.md` }],
            transcriptPointer: { kind: 'session', sessionId: f.source.id, seq: firstSeq } }]);
        await original.accept(prepared!);
        expect(f.acceptedPrompts[0]).not.toContain('Later original finding');
        expect(f.acceptedPrompts[0]).not.toContain('Actual later final result');
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id)))
            .toMatchObject({ deliveredTranscriptSeq: firstSeq, deliveredTurnId: null });
        const later = await original.prepare('natural');
        expect(later?.workerUpdates).toMatchObject([{ ownerState: 'published', result: 'Later original finding',
            transcriptPointer: { kind: 'session', sessionId: f.source.id, seq: secondSeq } }]);
        await original.accept(later!);
        expect(f.acceptedPrompts[1]).not.toContain('Aged original finding');
        expect(f.acceptedPrompts[1]).not.toContain('Actual later final result');
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id)))
            .toMatchObject({ deliveredTranscriptSeq: secondSeq, deliveredTurnId: null });
        const finalOriginal = await original.prepare('natural');
        expect(finalOriginal?.representedFollowLocalInputIds).toHaveLength(1);
        await original.accept(finalOriginal!);
        expect(f.acceptedPrompts[2]).toContain('Actual later final result');
        expect(f.acceptedPrompts[2]).not.toContain('Later original finding');
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id)))
            .toMatchObject({ deliveredTranscriptSeq: secondSeq + 2, deliveredTurnId: null });
        const terminal = await f.makeReconciler()({ signal: new AbortController().signal, deliveryIntent: 'wake' });
        expect(terminal?.workerUpdates).toMatchObject([{ ownerState: 'settled' }]);
        await f.commitWorkerWake(terminal!);
        terminal!.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: terminal!.wakeEventLocalId! });
        expect(await Promise.all(f.acknowledgements)).toEqual([
            expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true }),
            expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true }),
        ]);
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id)))
            .toMatchObject({ deliveredTurnId: 'later-turn', deliveredTurnStatus: 'completed' });
    });

    it('accepts distinct originals with identical text independently through overlapping routes', async () => {
        const f = await fixture();
        await f.follow();
        const original = await f.originals();
        const firstSeq = await f.appendReport('Identical original text');
        const secondSeq = await f.appendReport('Identical original text');
        for (const seq of [firstSeq, secondSeq]) {
            const prepared = await original.prepare('natural');
            expect(prepared?.workerUpdates).toMatchObject([{ result: 'Identical original text',
                transcriptPointer: { kind: 'session', sessionId: f.source.id, seq } }]);
            await original.accept(prepared!);
            expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id)))
                .toMatchObject({ deliveredTranscriptSeq: seq });
        }
        expect(f.acceptedPrompts.map(prompt => prompt.split('Identical original text').length - 1)).toEqual([1, 1]);
        expect(await db.sessionMessage.count({ where: { sessionId: f.destination.id, acceptedTurnId: 'receiver-turn' } })).toBe(2);
        expect(await original.prepare('natural')).toBeNull();
    });

    it('withdraws an overlapping preparation if a covered route changes before native dispatch', async () => {
        const f = await fixture();
        await f.follow();
        const original = await f.originals();
        await f.appendReport('Occurrence A');
        const prepared = await original.prepare('natural');
        expect(await prepared!.recheckAdmission(new AbortController().signal)).toBe(true);
        await db.sessionFollowEdge.delete({ where: { destinationSessionId_sourceSessionId_relation: {
            destinationSessionId: f.destination.id, sourceSessionId: f.source.id, relation: 'follower',
        } } });
        expect(await prepared!.recheckAdmission(new AbortController().signal)).toBe(false);
        expect(f.acceptedPrompts).toEqual([]);
        expect(f.acknowledgements).toEqual([]);
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id)))
            .toMatchObject({ deliveredTranscriptSeq: 1 });
    });

    it.each([
        ['completed', 'settled', 'agent state'], ['completed', 'settled', 'ready event'], ['completed', 'settled', 'transcript'],
        ['failed', 'failed', 'agent state'], ['cancelled', 'cancelled', 'agent state'],
    ] as const)(
        'does not repeat an ACKed %s/%s turn after unrelated %s progress, but delivers the next turn', async (status, ownerState, progress) => {
            const f = await fixture();
            await f.advanceTranscript();
            await db.session.update({ where: { id: f.source.id }, data: {
                latestTurnStatus: status, latestReadyEventSeq: 1,
            } });
            const prepared = await f.wake();
            expect(prepared?.workerUpdates).toEqual([expect.objectContaining({
                ownerState, result: 'Still working', transcriptPointer: { kind: 'session', sessionId: f.source.id, seq: 2 },
            })]);
            expect(await prepared?.recheckAdmission(new AbortController().signal)).toBe(true);
            expect((await f.wake())?.wakeEventLocalId).toBe(prepared?.wakeEventLocalId);
            await f.commitWorkerWake(prepared!);
            prepared!.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: prepared!.wakeEventLocalId! });
            expect(await Promise.all(f.acknowledgements)).toEqual([expect.objectContaining({ ok: true })]);
            expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id))).toMatchObject({
                deliveredTurnId: 'worker-turn', deliveredTurnStatus: status, deliveredTranscriptSeq: 2,
            });
            expect((await f.observe()).observations).toEqual([]);
            expect(await f.wake()).toBeNull();

            if (progress !== 'agent state') {
                await db.sessionMessage.create({ data: { sessionId: f.source.id, seq: 3, messageRole: 'event',
                    content: { t: 'plain', v: { role: 'agent', content: { type: 'event', data: progress === 'ready event'
                        ? { type: 'ready' } : { type: 'message', message: 'Unrelated diagnostic' } } } },
                    transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
            }
            await db.session.update({ where: { id: f.source.id }, data: progress === 'agent state'
                ? { agentStateVersion: { increment: 1 } }
                : progress === 'ready event' ? { seq: 3, latestReadyEventSeq: 3 } : { seq: 3 } });
            // The shared Follow frontier still observes numeric progress. That
            // progress is not another worker terminal transition.
            expect((await f.observe()).observations).toHaveLength(1);
            expect(await f.wake()).toBeNull();
            expect(f.acknowledgements).toHaveLength(1);
            await db.session.update({ where: { id: f.source.id }, data: { latestTurnId: 'next-worker-turn' } });
            expect((await f.wake())?.workerUpdates).toEqual([expect.objectContaining({ ownerState })]);
        },
    );

    it.each([['completed', 'settled'], ['in_progress', 'stalled']] as const)('does not re-emit the second worker turn (%s/%s) while its accepted frontier ACK is still in flight', async (status, ownerState) => {
        const f = await fixture();
        await f.advanceTranscript();
        await db.session.update({ where: { id: f.source.id }, data: { latestTurnStatus: 'completed', latestReadyEventSeq: 1 } });
        const first = await f.wake();
        await f.commitWorkerWake(first!);
        first!.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: first!.wakeEventLocalId! });
        expect(await f.acknowledgements[0]).toMatchObject({ ok: true });

        await f.appendTurnInput('second-worker-turn');
        await db.sessionMessage.create({ data: { sessionId: f.source.id, seq: 4, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Second result' } } } },
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
        await db.session.update({ where: { id: f.source.id }, data: {
            latestTurnId: 'second-worker-turn', latestTurnStatus: status, active: status === 'completed', seq: 4, agentStateVersion: 38,
        } });
        const second = await f.wake();
        expect(second?.workerUpdates).toEqual([expect.objectContaining({ ownerState, result: 'Second result' })]);
        expect(await second!.recheckAdmission(new AbortController().signal)).toBe(true);
        await f.commitWorkerWake(second!);
        let releaseAck!: () => void;
        f.ackTransport.beforeAcknowledge = () => new Promise<void>((resolve) => { releaseAck = resolve; });
        second!.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: second!.wakeEventLocalId! });
        try {
            // Ready/diagnostic events arrive after the deliverable turn fact,
            // while the real server ACK still sees the first delivered turn.
            await db.sessionMessage.create({ data: { sessionId: f.source.id, seq: 5, messageRole: 'event',
                content: { t: 'plain', v: { role: 'agent', content: { type: 'event', data: status === 'completed'
                    ? { type: 'ready' } : { type: 'message', message: 'Unrelated diagnostic' } } } },
                transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
            await db.session.update({ where: { id: f.source.id }, data: {
                seq: 5, latestReadyEventSeq: status === 'completed' ? 5 : 1, agentStateVersion: 39,
            } });
            expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id))).toMatchObject({
                deliveredTurnId: 'worker-turn', deliveredTranscriptSeq: 2,
            });
            expect((await f.observe()).observations).toHaveLength(1);
            expect(await f.wake()).toBeNull();
            expect(await second!.recheckAdmission(new AbortController().signal)).toBe(false);
        } finally {
            releaseAck();
            await f.acknowledgements[1];
        }
        expect(await f.acknowledgements[1]).toMatchObject({ ok: true });
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id))).toMatchObject({
            deliveredTurnId: 'second-worker-turn', deliveredTranscriptSeq: 4,
        });
        expect(await f.wake()).toBeNull();
        expect(await db.sessionMessage.count({ where: { sessionId: f.destination.id } })).toBe(2);
    });

    it('retains accepted worker custody through retryable ACK refusals and retries at the next boundary without another native input', async () => {
        const f = await fixture();
        const before = await inTx(tx => readSessionManagerInTx(tx, f.source.id));
        await f.advanceTranscript();
        await db.session.update({ where: { id: f.source.id }, data: { latestTurnStatus: 'completed' } });
        const prepared = await f.wake();
        expect(prepared?.workerUpdates?.[0]?.ownerState).toBe('settled');
        await f.commitWorkerWake(prepared!);
        f.ackTransport.retryable = true;
        prepared!.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: prepared!.wakeEventLocalId! });
        expect(await f.acknowledgements[0]).toMatchObject({ ok: false, error: 'retryable' });
        expect(await f.wake()).toBeNull();
        expect(f.acknowledgements).toHaveLength(2);
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id))).toEqual(before);
        f.ackTransport.retryable = false;
        expect(await f.wake()).toBeNull();
        expect(f.acknowledgements).toHaveLength(3);
        expect(await f.acknowledgements[2]).toMatchObject({ ok: true });
        expect(await inTx(tx => readSessionManagerInTx(tx, f.source.id))).toMatchObject({ deliveredTurnId: 'worker-turn' });
        expect(await db.sessionMessage.count({ where: { sessionId: f.destination.id } })).toBe(1);
        expect(await f.wake()).toBeNull();
        expect(f.acknowledgements).toHaveLength(3);
    });

    it.each(['wrong attachment', 'transport failure'] as const)('retains the terminal transition after ACK %s and consumes it after recovery', async (failure) => {
        const f = await fixture();
        await f.advanceTranscript();
        await db.session.update({ where: { id: f.source.id }, data: { latestTurnStatus: 'completed' } });
        const prepared = await f.wake();
        expect(prepared?.workerUpdates?.[0]?.ownerState).toBe('settled');
        await f.commitWorkerWake(prepared!);
        if (failure === 'wrong attachment') f.ackTransport.attachedAtOffset = 1;
        else f.ackTransport.beforeAcknowledge = async () => { throw new Error('socket disconnected'); };
        prepared!.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: prepared!.wakeEventLocalId! });
        if (failure === 'wrong attachment') {
            expect(await f.acknowledgements[0]).toEqual({ ok: false, rejection: 'stale_expected_frontier' });
        } else {
            await expect(f.acknowledgements[0]).rejects.toThrow('socket disconnected');
        }
        expect((await f.wake())?.wakeEventLocalId).toBe(prepared?.wakeEventLocalId);
        f.ackTransport.attachedAtOffset = 0;
        f.ackTransport.beforeAcknowledge = async () => {};
        prepared!.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: prepared!.wakeEventLocalId! });
        expect(await f.acknowledgements[1]).toMatchObject({ ok: true });
        expect(await f.wake()).toBeNull();
    });

    it('still delivers a new explicit publish after the terminal turn was ACKed', async () => {
        const f = await fixture('completed');
        const original = await f.originals();
        const localId = randomUUID();
        await db.sessionMessage.create({ data: { sessionId: f.source.id, seq: 2, localId, messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: localId,
                data: TranscriptRawAgentEventV1Schema.parse({ type: 'worker-report', summary: 'Published deliverable' }) } } },
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
        await db.session.update({ where: { id: f.source.id }, data: { seq: 2 } });
        const prepared = await original.prepare('wake');
        expect(prepared?.workerUpdates).toEqual([expect.objectContaining({ ownerState: 'published', result: 'Published deliverable' })]);
        await original.accept(prepared!);
        expect(await Promise.all(f.acknowledgements)).toEqual([expect.objectContaining({ ok: true })]);
        expect(await f.wake()).toBeNull();
    });

    it('delivers exactly one stalled update after offline mid-turn, ACKs it, and recovers without duplicate or completion', async () => {
        const f = await fixture();
        expect(await f.wake()).toBeNull();
        const leadChangeBefore = await db.accountChange.findFirstOrThrow({
            where: { kind: 'session', entityId: f.destination.id }, select: { cursor: true },
        });
        expect(await f.offline()).toMatchObject([{ status: 'expired' }]);
        const leadChangeAfter = await db.accountChange.findFirstOrThrow({
            where: { kind: 'session', entityId: f.destination.id }, select: { cursor: true },
        });
        expect(leadChangeAfter.cursor).toBeGreaterThan(leadChangeBefore.cursor);
        expect((await f.observe()).observations).toEqual([expect.objectContaining({
            observed: { transcriptSeq: 1, readyEventSeq: 0, agentStateVersion: 0,
                turn: { id: 'worker-turn', status: 'stalled' } },
        })]);
        const prepared = await f.wake();
        expect(prepared?.workerUpdates).toEqual([expect.objectContaining({ ownerState: 'stalled', wake: 'stalled', workerId: f.source.id })]);
        expect(prepared?.updates).toEqual([]);
        expect(await prepared?.recheckAdmission(new AbortController().signal)).toBe(true);
        expect(f.acknowledgements).toEqual([]);
        await db.sessionMessage.create({ data: { sessionId: f.destination.id, seq: 1,
            localId: prepared!.wakeEventLocalId!, messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'event',
                data: { type: 'message', message: SESSION_FOLLOW_WAKE_EVENT_MESSAGE } } } },
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' } } });
        prepared!.acknowledgeAccepted({ kind: 'context_only_wake', eventLocalId: prepared!.wakeEventLocalId! });
        expect(await Promise.all(f.acknowledgements)).toEqual([expect.objectContaining({ ok: true })]);
        expect((await f.observe()).observations).toEqual([]);
        expect(await f.wake(f.makeReconciler())).toBeNull(); // Lead restart/reconnect still reads the durable frontier.
        await db.session.update({ where: { id: f.source.id }, data: { active: true } });
        expect(await f.wake()).toBeNull();
        expect(await f.offline()).toMatchObject([{ status: 'expired' }]);
        expect(await f.wake()).toBeNull(); // Same turn remains acknowledged after recovery.
        await f.advanceTranscript();
        expect(await f.wake()).toBeNull(); // Unrelated transcript progress cannot re-report the stalled turn.
        await db.session.update({ where: { id: f.source.id }, data: { latestTurnId: 'next-worker-turn' } });
        expect((await f.wake())?.workerUpdates).toEqual([expect.objectContaining({ ownerState: 'stalled' })]);
    });

    it.each(['presence recovers', 'turn completes'] as const)('withdraws a prepared stalled wake if %s before dispatch', async (recovery) => {
        const f = await fixture();
        await f.offline();
        const prepared = await f.wake();
        expect(prepared?.workerUpdates?.[0]?.ownerState).toBe('stalled');
        await f.advanceTranscript(); // Recovery still has a pending ordinary frontier.
        await db.session.update({ where: { id: f.source.id }, data: recovery === 'presence recovers'
            ? { active: true } : { latestTurnStatus: 'completed' } });
        expect(await prepared?.recheckAdmission(new AbortController().signal)).toBe(false);
        expect(f.acknowledgements).toEqual([]);
    });

    it('does not deliver stalled for an inactive completed turn whose frontier was already accepted', async () => {
        const f = await fixture('completed');
        expect(await f.offline()).toMatchObject([{ status: 'expired' }]);
        expect((await f.observe()).observations).toEqual([]);
        expect(await f.wake()).toBeNull();
    });
});
