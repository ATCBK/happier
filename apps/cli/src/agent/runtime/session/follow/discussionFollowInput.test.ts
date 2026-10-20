import { beforeEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, createActionExecutor, encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createCliArtifactActions } from '@/session/actions/artifactActions';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { createMutableApiSessionClientFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import type { CliActionMachineAdmissionTransport } from '@/session/actions/createCliActionExecutorFromCredentials';
import { buildPluginSessionInputAdmissionV1 } from '@/session/services/sessionInputAdmissionIdentity';
import { settleSessionInputRequestV1, withSessionInputAuthorityV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import { createDiscussionFollowInputIntake } from './discussionFollowInput';
import type { FollowEventV1, FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), request: vi.fn() }));
// Only the HTTP and authenticated Machine socket are replaced; resource opening,
// protected admission, receiver policy and the Pending send owner remain real.
vi.mock('axios', () => ({ default: http }));

const sessionId = 'c123456789012345678901234';
const addressing = { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: sessionId };
const route = { policy: { preset: 'quiet' }, event: { kind: 'needs_you', type: 'decision', mode: 'wait' } } as const;
const actor = { v: 1, accountId: 'owner', profile: null };
const message = { id: 'question', discussionId: 'discussion', localId: 'question', seq: 2,
  authorAccountId: 'owner', accountActor: actor, producerV1: null,
  content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'What changed?' }, { t: 'mention', participant: { kind: 'session', sessionId } }] } },
  mentionedAccountIds: [], addressingV1: { throughSeq: 2, participantSessionIds: [sessionId] }, createdAt: 1 };
const features = { status: 'ready' as const, features: FeaturesResponseSchema.parse({
  features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } }, capabilities: {},
}) };

beforeEach(() => {
  vi.clearAllMocks();
  http.post.mockImplementation(async (url: string) => {
    if (url.endsWith('/v2/sessions/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
    if (url.endsWith('/v2/sessions/query')) return { status: 200, data: {
      sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false } };
    throw new Error(`Unexpected Session lookup request: ${url}`);
  });
  http.request.mockImplementation(async ({ url }: { url: string }) => {
    const path = new URL(url).pathname;
    if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200, data: { sessions: [], nextCursor: null, hasNext: false } };
    if (path.endsWith('/messages')) return { status: 200, data: { messages: [message], hasMoreOlder: false, messageSeq: 2 } };
    if (path === '/v1/discussions/discussion') return { status: 200, data: { discussion: {
      id: 'discussion', ownerAccountId: 'owner', encryptionMode: 'plain', anchor: null, access: 'owner', keyReadiness: true,
      dataEncryptionKey: null, creationLocalId: 'creation', titleContent: { t: 'plain', v: { v: 1, title: 'Question' } },
      latestMessage: { id: message.id, localId: message.localId, seq: message.seq, authorAccountId: 'owner', accountActor: actor,
        producerV1: null, createdAt: 1 }, messageSeq: 2, lastReadSeq: 0, unreadCount: 1, unreadMentionCount: 0,
      recentAuthorAccountIds: ['owner'], archivedAt: null, capabilities: { postMessages: true, rename: true, archive: true,
        restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
    } } };
    throw new Error(`Unexpected resource HTTP request: ${path}`);
  });
  http.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/messages/reply-capability')) return { status: 200, data: { v: 1, protocolVersions: [1] } };
    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (url.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
    if (new URL(url).pathname === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: {
      ...createSessionNotificationContextFixture(sessionId),
      id: sessionId, seq: 1, createdAt: 1, updatedAt: 2, active: true, activeAt: 1, archivedAt: null,
      latestTurnStatus: 'in_progress', pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
      encryptionMode: 'plain', metadataVersion: 0, agentState: null, agentStateVersion: 0,
      pendingCount: 0, pendingVersion: 0, share: null, dataEncryptionKey: null,
      metadata: JSON.stringify({ machineId: 'machine', path: '/repo', claudeSessionId: 'native',
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } }),
    } } };
    throw new Error(`Unexpected Session HTTP request: ${url}`);
  });
});

it.each([
  { policy: { preset: 'quiet' }, event: route.event, accepted: true, wakes: true },
  { policy: { preset: 'custom', events: { needs_you: { decision: { delivery: 'off' } } } }, event: route.event, accepted: true, wakes: true },
  { policy: { preset: 'important' }, event: route.event, accepted: true, wakes: true },
  { policy: { preset: 'quiet' }, event: { kind: 'person_wrote' }, accepted: true, wakes: false },
  { policy: { preset: 'custom', events: { person_wrote: { delivery: 'quiet' } } }, event: { kind: 'person_wrote' }, accepted: true, wakes: false },
  { policy: { preset: 'custom', events: { needs_you: { decision: { delivery: 'interrupt' } }, message: { delivery: 'off' } } },
    event: { kind: 'message' }, accepted: false, wakes: false },
] satisfies { policy: FollowPolicyV1; event: FollowEventV1; accepted: boolean; wakes: boolean }[])(
  'uses persisted $policy.preset/$event.kind for the original Pending input and inactive receiver wake', async ({ policy, event, accepted, wakes }) => {
    const sessionTransport = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string, ...options: unknown[]) => {
      const response = await sessionTransport(url, ...options);
      return new URL(url).pathname === `/v2/sessions/${sessionId}`
        ? { ...response, data: { session: { ...response.data.session, active: false, latestTurnStatus: 'completed' } } } : response;
    });
    if (event.kind !== 'needs_you') {
      const resourceTransport = http.request.getMockImplementation()!;
      http.request.mockImplementation(async (request: { url: string }) => {
        const response = await resourceTransport(request);
        return new URL(request.url).pathname.endsWith('/messages') ? { ...response, data: { ...response.data, messages: [
          { ...message, addressingV1: { ...message.addressingV1, watcherSessionIds: [sessionId] } },
        ] } } : response;
      });
    }
    const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
    const admission = vi.fn<CliActionMachineAdmissionTransport>(async () => ({ status: 'accepted', localId }));
    // Only the daemon process launch boundary is replaced; receiver admission
    // and requestInactiveSessionResume remain the production owners.
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId }));
    const session = createMutableApiSessionClientFixture({ sessionId, overrides: {
      getServerFeaturesSnapshot: () => features, getMachineAdmissionTransport: () => admission,
      runSessionFollowSourceRequest: ({ request }) => request(),
    } });
    const intake = createDiscussionFollowInputIntake({ session, credentials: { token: 'token', encryption: null }, spawnSession });
    expect(await intake({ observation: { source: { kind: 'discussion', discussionId: 'discussion' },
      destinationSessionId: sessionId, addressing, policy, event }, signal: new AbortController().signal })).toBe(accepted);
    expect(admission.mock.calls.length).toBe(accepted ? 1 : 0);
    expect(spawnSession.mock.calls.length).toBe(wakes ? 1 : 0);
    if (accepted) expect(admission.mock.calls[0]?.[0].reply).toMatchObject({ mode: 'return', discussion: addressing });
  });

it.each(['busy', 'person_stopped', 'muted'] as const)('keeps default-Quiet direct asks under the existing %s receiver admission', async state => {
  const sessionTransport = http.get.getMockImplementation()!;
  http.get.mockImplementation(async (url: string, ...options: unknown[]) => {
    const response = await sessionTransport(url, ...options);
    if (url.endsWith('/delivery-mutes') && state === 'muted') return { status: 200, data: {
      scopes: [{ kind: 'source', source: { kind: 'discussion', discussionId: addressing.discussionId } }],
    } };
    if (new URL(url).pathname !== `/v2/sessions/${sessionId}`) return response;
    const current = response.data.session;
    return { ...response, data: { session: { ...current, active: state === 'busy',
      latestTurnStatus: state === 'busy' ? 'in_progress' : 'completed',
      metadata: JSON.stringify({ ...JSON.parse(current.metadata), ...(state === 'person_stopped' ? {
        sessionExplicitStopV1: { v: 1, cause: 'explicit_stop', requestId: 'person-stop', requestedAtMs: 1 },
      } : {}) }),
    } } };
  });
  const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
  const admission = vi.fn<CliActionMachineAdmissionTransport>(async () => ({ status: 'accepted', localId }));
  const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId }));
  const session = createMutableApiSessionClientFixture({ sessionId, overrides: {
    getServerFeaturesSnapshot: () => features, getMachineAdmissionTransport: () => admission,
    runSessionFollowSourceRequest: ({ request }) => request(),
  } });
  const intake = createDiscussionFollowInputIntake({ session, credentials: { token: 'token', encryption: null }, spawnSession });
  expect(await intake({ observation: { source: { kind: 'discussion', discussionId: addressing.discussionId },
    destinationSessionId: sessionId, addressing, ...route }, signal: new AbortController().signal })).toBe(state !== 'muted');
  expect(spawnSession).not.toHaveBeenCalled();
  if (state === 'muted') expect(admission).not.toHaveBeenCalled();
  else expect(admission).toHaveBeenCalledWith(expect.objectContaining({ requestedAction: { v: 1, kind: 'enqueue' },
    reply: expect.objectContaining({ mode: 'return', discussion: addressing }) }), expect.anything());
});

it('admits a human-addressed original into existing Machine Pending without inventing a causal Session or steering a busy turn', async () => {
  const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
  const admission = vi.fn<CliActionMachineAdmissionTransport>(async () => ({ status: 'accepted', localId }));
  const session = createMutableApiSessionClientFixture({ sessionId, overrides: {
    getServerFeaturesSnapshot: () => features,
    getMachineAdmissionTransport: () => admission,
    runSessionFollowSourceRequest: ({ request }) => request(),
  } });
  const binding = session.getServerBinding();
  const resource = await createDiscussionActionDeps({ credentials: { token: 'token', encryption: null }, serverId: binding.serverId,
    serverHttpBaseUrl: binding.serverUrl, resolveServerFeaturesSnapshot: () => features }).discussionAction!({ actionId: 'discussion.read',
    input: { discussionId: addressing.discussionId, afterSeq: 1, throughSeq: 2 }, context: {
      surface: 'cli', authority: 'account_automation', serverId: binding.serverId,
    } });
  expect(resource).toMatchObject({ messages: [{ id: addressing.messageId, addressingV1: message.addressingV1, content: message.content.v }] });
  const intake = createDiscussionFollowInputIntake({ session, credentials: { token: 'token', encryption: null } });
  const admitted = await intake({ observation: { source: { kind: 'discussion', discussionId: addressing.discussionId },
    destinationSessionId: sessionId, addressing, ...route }, signal: new AbortController().signal });
  expect({ admitted, resourcePaths: http.request.mock.calls.map(([request]) => request.url),
    sessionPaths: http.get.mock.calls.map(([url]) => url), pendingCount: admission.mock.calls.length }).toMatchObject({ admitted: true });
  expect(admission).toHaveBeenCalledWith(expect.objectContaining({ localId, sessionId,
    requestedAction: { v: 1, kind: 'enqueue' }, reply: expect.objectContaining({ mode: 'return', discussion: addressing }),
    content: { t: 'plain', v: expect.objectContaining({ meta: expect.objectContaining({ happierInputRequestV1: expect.objectContaining({
      discussionAddressing: addressing, replyIntent: { mode: 'return' },
    }) }) }) },
  }), expect.any(Object));
  const request = admission.mock.calls[0]?.[0];
  expect(request?.content).toMatchObject({ t: 'plain', v: { meta: { happierInputRequestV1: {
    actionRequestAttributionV1: { requestRef: localId, requester: { serverId: binding.serverId, accountId: 'owner' },
      persona: { serverId: binding.serverId, sessionId }, origin: { kind: 'discussion',
        discussion: { serverId: binding.serverId, discussionId: addressing.discussionId }, messageId: addressing.messageId } },
  } } } });
  expect(request).not.toHaveProperty('reply.sourceSession');
  expect(request).not.toHaveProperty('content.v.meta.happierInputRequestV1.sourceSession');
});

it.each(['available', 'private', 'missing_original'] as const)('retains the Agent original causal ceiling without substituting receiver authority (%s)', async state => {
  const sourceId = 'c223456789012345678901234';
  const sourceSession = { sourceSessionId: sourceId, sourceTurnId: 'source-turn', sourceInputId: 'source-input', via: 'action' as const };
  const originalAttribution = { requestRef: 'causal-original', requester: { serverId: 'home', accountId: 'original-person' },
    persona: { serverId: 'home', sessionId: sourceId }, origin: { kind: 'session' as const,
      session: { serverId: 'home', sessionId: sourceId }, messageId: 'original' } };
  const original = buildPluginSessionInputAdmissionV1({ actionRequestAttributionV1: originalAttribution,
    caller: { kind: 'plugin', pluginId: 'example.source', contributionLocalId: 'bridge' }, source: {
    sourceRef: 'private-mediated-ref', sourceRevisionOrEpoch: 'revision', requestedPermissionCeiling: 'read-only', remoteApprovalMaxScope: 'request',
  } });
  const inputAdmissionReceipt = { v: 1 as const, issuer: 'authenticatedMachine' as const };
  const authority = settleSessionInputRequestV1({ request: original.request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt });
  const resourceTransport = http.request.getMockImplementation()!;
  const sessionTransport = http.get.getMockImplementation()!;
  http.request.mockImplementation(async (request: { url: string }) => {
    const response = await resourceTransport(request);
    return new URL(request.url).pathname.endsWith('/messages') ? { ...response, data: { ...response.data, messages: [
      { ...message, producerV1: { v: 1, kind: 'agent', sessionId: sourceId, sourceSession } },
    ] } } : response;
  });
  http.get.mockImplementation(async (url: string, ...options: unknown[]) => {
    const path = new URL(url).pathname;
    if (path === `/v2/sessions/${sourceId}`) return state === 'private' ? { status: 404, data: { error: 'Session not found' } }
      : { status: 200, data: { session: { ...createSessionNotificationContextFixture(sourceId), encryptionMode: 'plain', workDepth: 3,
        metadata: JSON.stringify({ machineId: 'machine', path: '/repo' }) } } };
    if (path.endsWith('/messages/by-local-id/source-input')) return state === 'missing_original'
      ? { status: 404, data: { error: 'Message not found' } } : { status: 200, data: { message: {
        id: 'original', localId: 'source-input', seq: 1, sidechainId: null, createdAt: 1, updatedAt: 1, messageRole: 'user', inputAdmissionReceipt,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Original mediated input' },
          meta: withSessionInputAuthorityV1({ happierProvenanceV1: original.provenance }, authority) } },
      } } };
    return sessionTransport(url, ...options);
  });
  const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
  const admission = vi.fn<CliActionMachineAdmissionTransport>(async () => ({ status: 'accepted', localId }));
  const session = createMutableApiSessionClientFixture({ sessionId, overrides: {
    getServerFeaturesSnapshot: () => features, getMachineAdmissionTransport: () => admission,
    runSessionFollowSourceRequest: ({ request }) => request(),
  } });
  const admitted = await createDiscussionFollowInputIntake({ session, credentials: { token: 'token', encryption: null } })({
    observation: { source: { kind: 'discussion', discussionId: addressing.discussionId }, destinationSessionId: sessionId, addressing, ...route },
    signal: new AbortController().signal,
  });
  expect(http.get).toHaveBeenCalledWith(expect.stringContaining(`/v2/sessions/${sourceId}`), expect.anything());
  if (state !== 'available') {
    expect(admitted).toBe(false);
    expect(admission).not.toHaveBeenCalled();
    return;
  }
  expect(admitted).toBe(true);
  expect(admission).toHaveBeenCalledWith(expect.objectContaining({ reply: { mode: 'return', discussion: addressing, sourceSession,
    actionRequestAttributionV1: originalAttribution },
    content: { t: 'plain', v: expect.objectContaining({ meta: expect.objectContaining({ happierInputRequestV1: expect.objectContaining({ sourceSession,
      permission: { requestedPermissionCeiling: 'read-only' }, sourceAuthority: original.request.sourceAuthority,
      actionRequestAttributionV1: originalAttribution,
    }) }) }) },
  }), expect.anything());
});

it('submits the private foreign question for canonical held custody without reading or fabricating source authority', async () => {
  const sourceId = 'c223456789012345678901234';
  const sourceSession = { sourceSessionId: sourceId, sourceTurnId: 'private-turn', sourceInputId: 'private-input', via: 'action' as const };
  const sessionTransport = http.get.getMockImplementation()!;
  http.get.mockImplementation(async (url: string, ...options: unknown[]) => new URL(url).pathname === `/v2/sessions/${sourceId}`
    ? { status: 404, data: { error: 'Session not found' } } : sessionTransport(url, ...options));
  const resourceTransport = http.request.getMockImplementation()!;
  http.request.mockImplementation(async (request: { url: string }) => {
    const response = await resourceTransport(request);
    return new URL(request.url).pathname.endsWith('/messages') ? { ...response, data: { ...response.data, messages: [
      { ...message, authorAccountId: 'foreign-owner', accountActor: { ...actor, accountId: 'foreign-owner' },
        producerV1: { v: 1, kind: 'agent', sessionId: sourceId, sourceSession } },
    ] } } : response;
  });
  const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
  const admission = vi.fn<CliActionMachineAdmissionTransport>(async () => ({ status: 'accepted', localId }));
  const session = createMutableApiSessionClientFixture({ sessionId, overrides: {
    getServerFeaturesSnapshot: () => features, getMachineAdmissionTransport: () => admission,
    runSessionFollowSourceRequest: ({ request }) => request(),
  } });
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
  const intake = createDiscussionFollowInputIntake({ session, credentials: { token, encryption: null } });
  expect(await intake({ observation: { source: { kind: 'discussion', discussionId: addressing.discussionId }, destinationSessionId: sessionId,
    addressing, ...route }, signal: new AbortController().signal })).toBe(true);
  expect(admission).toHaveBeenCalledWith(expect.objectContaining({ sessionId, targetMachineId: 'machine', localId,
    reply: { mode: 'return', discussion: addressing, sourceSession }, requestedAction: { v: 1, kind: 'enqueue' },
    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: expect.stringContaining('What changed?') } } },
  }), expect.anything());
  expect(admission.mock.calls[0]?.[0].content).not.toHaveProperty('v.meta');
  expect(http.get.mock.calls.some(([url]) => String(url).includes(sourceId))).toBe(false);
});

it.each(['comment', 'proposal', 'inherited', 'untitled', 'restricted-count', 'creator-label', 'redo-labels', 'foreign-row'] as const)('admits only the compact authorized Doc card and authored question (%s)', async variant => {
  const kind = variant === 'proposal' || variant === 'redo-labels' ? 'proposal' : variant === 'inherited' ? 'inherited' : 'comment';
  const title = variant === 'untitled' ? null : 'Authorized title';
  const observedAddressing = { ...addressing, throughSeq: kind === 'inherited' ? 4 : 2 };
  const localId = deriveDiscussionFollowInputLocalIdV1(observedAddressing);
  const admission = vi.fn<CliActionMachineAdmissionTransport>(async () => ({ status: 'accepted', localId }));
  const session = createMutableApiSessionClientFixture({ sessionId, serverBinding: { serverId: 'captured-home', serverUrl: 'http://captured-home.test' }, overrides: {
    getServerFeaturesSnapshot: () => features, getMachineAdmissionTransport: () => admission,
    runSessionFollowSourceRequest: ({ request }) => request(),
  } });
  const binding = session.getServerBinding();
  const body = 'PRIVATE_DOC_PASSAGE_'.repeat(12_000);
  const revision = { headerVersion: 1, bodyVersion: 2 };
  const ref = { kind: 'doc' as const, serverId: variant === 'creator-label' || variant === 'redo-labels'
    ? 'creator-client-only-profile' : binding.serverId, artifactId: 'doc' };
  const admittedRef = { ...ref, serverId: binding.serverId };
  const target = { ref, revision, range: { start: 0, end: body.length }, quote: body, prefix: 'PRIVATE_PREFIX', suffix: 'PRIVATE_SUFFIX' };
  const root = { ...message, id: 'root', localId: 'root', seq: 1, addressingV1: undefined,
    replyTarget: { kind: 'doc_passage', doc: { ref, revision } },
    content: { t: 'plain', v: { kind: 'doc_passage_comment', passage: target, content: message.content.v } } };
  const reason = 'Please review this proposed change';
  const proposalRevision = { headerVersion: 2, bodyVersion: 3 };
  const middle = { ...message, id: 'middle', localId: 'middle', seq: 3, addressingV1: undefined,
    replyTarget: { kind: 'message', messageId: 'root' } };
  const question = { ...message, seq: observedAddressing.throughSeq,
    ...(variant === 'foreign-row' ? { discussionId: 'foreign-thread' } : {}),
    addressingV1: { ...message.addressingV1, throughSeq: observedAddressing.throughSeq },
    replyTarget: kind === 'inherited' ? { kind: 'message', messageId: 'middle' }
      : kind === 'proposal' ? { kind: 'message', messageId: 'root' } : root.replyTarget,
    content: kind === 'inherited' ? message.content : kind === 'comment' ? root.content
      : { t: 'plain', v: { kind: 'doc_edit_proposal', proposal: { target: { ...target,
        ref: variant === 'redo-labels' ? { ...ref, serverId: 'redo-client-only-profile' } : ref,
        revision: proposalRevision }, baseRevision: proposalRevision, before: body,
        after: 'PRIVATE_REPLACEMENT', reason } } } };
  const resourceTransport = http.request.getMockImplementation()!;
  const sessionTransport = http.get.getMockImplementation()!;
  const countQueries: string[] = [];
  http.request.mockImplementation(async (request: { url: string }) => {
    const url = new URL(request.url);
    if (url.pathname === '/v1/discussions') {
      countQueries.push(url.search);
      if (variant === 'restricted-count') return { status: 403, data: { error: 'discussion_access_denied' } };
      const details = await resourceTransport({ url: `${binding.serverUrl}/v1/discussions/discussion` });
      return { status: 200, data: { discussions: [{ ...details.data.discussion,
        anchor: { kind: 'doc', doc: { ref, revision } }, firstMessage: root }], nextCursor: null } };
    }
    if (url.pathname === '/v1/discussions/discussion/messages') return { status: 200, data: {
      messages: !url.searchParams.has('beforeSeq') ? [question]
        : kind === 'inherited' && Number(url.searchParams.get('beforeSeq')) > middle.seq ? [middle] : [root],
      hasMoreOlder: !url.searchParams.has('beforeSeq') || kind === 'inherited' && Number(url.searchParams.get('beforeSeq')) > middle.seq,
      messageSeq: observedAddressing.throughSeq,
    } };
    return resourceTransport(request);
  });
  const stored = { id: 'doc', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 3, bodyVersion: 4, seq: 1, createdAt: 1, updatedAt: 2,
    header: encodePlainArtifactStoredContent({ kind: 'doc.v1', ...(title === null ? {} : { title }) }), body: encodePlainArtifactStoredContent({ body }) };
  http.get.mockImplementation(async (url: string, ...options: unknown[]) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/artifacts') {
      expect(parsed.origin).toBe(binding.serverUrl);
      return { status: 200, data: [{ ...stored, body: undefined }] };
    }
    if (parsed.pathname === '/v1/artifacts/doc') return { status: 200, data: stored };
    return sessionTransport(url, ...options);
  });
  const credentials = { token: 'token', encryption: null };
  const admitted = await createDiscussionFollowInputIntake({ session, credentials })({ observation: {
    source: { kind: 'discussion', discussionId: addressing.discussionId }, destinationSessionId: sessionId, addressing: observedAddressing, ...route,
  }, signal: new AbortController().signal });
  if (variant === 'foreign-row') {
    expect(admitted).toBe(false);
    expect(admission).not.toHaveBeenCalled();
    expect(countQueries).toEqual([]);
    expect(http.get.mock.calls.some(([url]) => new URL(String(url)).pathname.startsWith('/v1/artifacts'))).toBe(false);
    return;
  }
  expect(admitted).toBe(true);
  const pending = admission.mock.calls[0]?.[0];
  if (pending?.content.t !== 'plain') throw new Error('Expected accepted plaintext Pending fixture');
  const accepted = pending.content.v;
  if (!accepted || typeof accepted !== 'object' || !('content' in accepted) || !accepted.content
    || typeof accepted.content !== 'object' || !('text' in accepted.content) || typeof accepted.content.text !== 'string') {
    throw new Error('Expected accepted text input');
  }
  const text = accepted.content.text;
  expect(text).not.toContain('PRIVATE_DOC_PASSAGE_');
  expect(text).not.toContain('PRIVATE_REPLACEMENT');
  expect(text).not.toContain('PRIVATE_PREFIX');
  expect(text).not.toContain('PRIVATE_SUFFIX');
  const card = JSON.parse(text.slice(text.indexOf('\n') + 1));
  expect(card.doc).toEqual({ docRef: admittedRef, title, revision: kind === 'proposal' ? proposalRevision : revision,
    openCommentCount: variant === 'restricted-count' ? null : 1,
    threadRef: { kind: 'discussion', discussion: { serverId: binding.serverId, discussionId: addressing.discussionId },
      messageId: kind === 'comment' ? 'question' : 'root' } });
  expect(text.slice(0, text.indexOf('\n'))).toContain('doc.read');
  expect(text).toContain(kind === 'proposal' ? reason : 'What changed?');
  expect(pending).not.toHaveProperty('reply.sourceSession');
  expect(http.get.mock.calls.some(([url]) => new URL(String(url)).pathname === '/v1/artifacts/doc')).toBe(false);
  expect(countQueries).toEqual(['?state=active&anchorDocArtifactId=doc']);
  // Explicit doc.read keeps the existing Action, grant/mode and Artifact codec path;
  // only HTTP and the authenticated Pending transport are replaced above.
  const store = createCredentialedAccountArtifactStore(credentials);
  const artifactAction = createCliArtifactActions({ store,
    beforeDelete: async () => { throw new Error('Read-only fixture'); }, resolvePublishCaller: async () => null });
  await expect(runWithServerHttpBaseUrl(binding.serverUrl, () => createActionExecutor({ ...createUnavailableActionTransportDeps(), artifactAction }).execute('doc.read', { ref: admittedRef }, {
    surface: 'cli', authority: 'account_automation', serverId: binding.serverId,
  }))).resolves.toMatchObject({ ok: true, result: { ref: admittedRef, artifact: { body }, openCommentCount: null } });
});

it.each(['denied', 'unavailable', 'malformed'] as const)('does not admit Doc source content or title when source is %s', async state => {
  const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
  const admission = vi.fn<CliActionMachineAdmissionTransport>(async () => ({ status: 'accepted', localId }));
  const session = createMutableApiSessionClientFixture({ sessionId, overrides: {
    getServerFeaturesSnapshot: () => features, getMachineAdmissionTransport: () => admission,
    runSessionFollowSourceRequest: ({ request }) => request(),
  } });
  const ref = { kind: 'doc', serverId: session.getServerBinding().serverId, artifactId: 'doc' };
  const revision = { headerVersion: 1, bodyVersion: 1 };
  const resourceTransport = http.request.getMockImplementation()!;
  const sessionTransport = http.get.getMockImplementation()!;
  http.request.mockImplementation(async (request: { url: string }) => new URL(request.url).pathname.endsWith('/messages')
    ? { status: 200, data: { messages: [{ ...message, replyTarget: { kind: 'doc_passage', doc: { ref, revision } },
      content: { t: 'plain', v: { kind: 'doc_passage_comment', passage: { ref, revision, range: { start: 0, end: 7 }, quote: 'PRIVATE' },
        content: message.content.v } } }], hasMoreOlder: false, messageSeq: 2 } } : resourceTransport(request));
  http.get.mockImplementation(async (url: string, ...options: unknown[]) => new URL(url).pathname === '/v1/artifacts'
    ? state === 'denied' ? { status: 200, data: [] } : state === 'unavailable' ? { status: 503, data: { error: 'source_unavailable' } }
      : { status: 200, data: [{ id: 'doc', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        header: encodePlainArtifactStoredContent({ kind: 'doc.v1', title: 17 }) }] }
    : sessionTransport(url, ...options));
  expect(await createDiscussionFollowInputIntake({ session, credentials: { token: 'token', encryption: null } })({ observation: {
    source: { kind: 'discussion', discussionId: addressing.discussionId }, destinationSessionId: sessionId, addressing, ...route,
  }, signal: new AbortController().signal })).toBe(false);
  expect(admission).not.toHaveBeenCalled();
});
