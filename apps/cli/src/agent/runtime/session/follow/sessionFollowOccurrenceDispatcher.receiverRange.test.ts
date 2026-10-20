import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createSessionFollowOccurrenceDispatcher } from './sessionFollowOccurrenceDispatcher';
import { SessionFollowRuleSourceOccurrenceV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import { SessionFollowPersonalProgressRequestV1Schema, type SessionFollowPersonalProgressRequestV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createPersonalFollowOccurrenceDispatcher } from '@/notifications/activity/dispatchPersonalFollowOccurrence';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { notificationCatalogFixture } from '@/notifications/activity/activityNotification.testkit';

afterEach(() => vi.restoreAllMocks());

it.each(['receiver', 'source'] as const)('opens the first original range for a fresh rule without an edge or encountered source and keeps an unreadable range pending (%s)', async entry => {
  const sourceSessionId = 'c111111111111111111111111';
  const destinationSessionId = 'c222222222222222222222222';
  const token = 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature';
  const rule = { ruleId: 'new-rule', version: 0, receiver: { kind: 'session' as const, sessionId: destinationSessionId },
    inception: { accountChangeCursor: 5, createdAt: 100 },
    content: { t: 'plain' as const, v: { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' }),
      policy: { preset: 'important' as const } } } };
  const source = { ...createSessionNotificationContextFixture(sourceSessionId), encryptionMode: 'plain', dataEncryptionKey: null,
    metadata: JSON.stringify({ path: '/work', host: 'host', machineId: 'source-machine' }), ownerAccountId: 'account-1',
    archivedAt: null, active: true, seq: 2, origin: { kind: 'none' as const } };
  const destination = { ...source, id: destinationSessionId, seq: 0 };
  let readable = false;
  const afterSequences: number[] = [];
  const pending: unknown[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    if (path.endsWith('/follows/sessions')) return { status: 200, data: { sources: [] } };
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200,
      data: { sessions: [], hasNext: false, nextCursor: null } };
    if (path === '/v2/account/session-follow-rules') {
      const demanded = options?.params?.destinationSessionId;
      return { status: 200, data: { rules: [rule], ...(demanded ? { sourceRanges: { status: 'available', sources: [{
        sourceSessionId, delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 1 }, throughSeq: 2,
      }] } } : {}) } };
    }
    if (path === '/v2/account/session-follow-preferences') return { status: 200,
      data: { assigned: false, direct: false, team: false, group: false } };
    if (path === `/v2/sessions/${sourceSessionId}`) return readable ? { status: 200, data: { session: source } } : { status: 404, data: {} };
    if (path === `/v2/sessions/${destinationSessionId}`) return { status: 200, data: { session: destination } };
    if (path.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
    if (path.includes('/messages')) {
      afterSequences.push(Number(options?.params?.afterSeq ?? parsed.searchParams.get('afterSeq')));
      const original = { id: 'original-2', seq: 2, localId: 'new-original', createdAt: 200,
        content: { t: 'plain' as const, v: { role: 'agent', content: { type: 'event', id: 'goal', data: { type: 'goal-changed' } } } } };
      return { status: 200, data: { messages: [original],
        hasMore: false, nextAfterSeq: null } };
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v2/sessions/lookup-by-tags') return { status: 200, data: { sessions: [] } };
    if (path.endsWith('/follows/occurrence-routes')) return { status: 200,
      data: { ok: true, v: 1, sourceSessionId, originalCreatedAt: 200, routes: [] } };
    if (path.endsWith('/pending')) { pending.push(body); return { status: 200,
      data: { didWrite: true, message: { localId: 'accepted-original', seq: 1 } } }; }
    throw new Error(`Unexpected POST ${path}`);
  });
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: { token, encryption: null },
    serverId: 'home', serverHttpBaseUrl: 'http://home.test', machineId: entry === 'source' ? 'source-machine' : 'receiver-machine', installationId: 'installation',
    signal: new AbortController().signal, isCurrent: async () => true, subscribeInvalidation: () => () => {},
    resolveSourceKeyContext: async () => null, isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
  try {
    const dispatch = () => entry === 'receiver' ? dispatcher.dispatchReceiverRange({ destinationSessionId, observations: [] })
      : dispatcher.dispatch(SessionFollowRuleSourceOccurrenceV1Schema.parse({ sourceSessionId,
          sourcePublisher: { machineId: 'source-machine', publisherGeneration: '1', committedFenceMs: 1 },
          sourceMessage: { localId: 'new-original', seq: 2 }, evidence: { v: 1, ownerAccountId: 'account-1',
            event: { kind: 'goal_changed' }, facts: { serverId: 'home', kind: 'session', source: 'persisted' } } }));
    await dispatch();
    expect(pending).toEqual([]);
    readable = true;
    const available = await dispatch();
    expect(afterSequences).toEqual([1]);
    if (entry === 'receiver') expect(available).toMatchObject({ coveredEvents: [{ sourceSessionId, kind: 'goal_changed' }] });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ followSources: [entry === 'source'
      ? { expectedSourcePublisherGeneration: '1', machineId: 'source-machine', installationId: 'installation' }
      : { evaluation: 'receiver' }] });
  } finally { dispatcher.dispose(); }
});

it.each(['complete', 'unavailable-route', 'unavailable-mute', 'optout-before-dispatch', 'unavailable-personal-scope'] as const)(
  'settles one complete current personal request map and keeps native policy return independent (%s)', async availability => {
    const sourceSessionId = 'c333333333333333333333333';
    const token = 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature';
    const credentials = { token, encryption: null };
    const serverHttpBaseUrl = 'http://personal-request-group.test';
    const rule = { ruleId: 'personal-rule', version: 0, receiver: { kind: 'account' as const },
      inception: { accountChangeCursor: 5, createdAt: 100 }, content: { t: 'plain' as const,
        v: { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' }),
          policy: { preset: 'important' as const } } } };
    const source = { ...createSessionNotificationContextFixture(sourceSessionId), encryptionMode: 'plain', dataEncryptionKey: null,
      metadata: JSON.stringify({ path: '/work', host: 'host', machineId: 'source-machine' }), ownerAccountId: 'account-1',
      archivedAt: null, active: true, seq: 0, agentStateVersion: 1, origin: { kind: 'none' as const } };
    const requests = [{ requestId: 'A', createdAt: availability === 'complete' || availability === 'optout-before-dispatch' ? 90 : 200 },
      { requestId: 'B', createdAt: 300 }];
    const evidence = { v: 1, ownerAccountId: 'account-1', event: { kind: 'needs_you', type: 'decision' },
      facts: { serverId: 'home', kind: 'session', startedBy: 'you' } };
    const occurrence = SessionFollowRuleSourceOccurrenceV1Schema.parse({ sourceSessionId,
      sourcePublisher: { machineId: 'source-machine', publisherGeneration: '1', committedFenceMs: 1 },
      sourceRequests: { agentStateVersion: 1, requests }, requestEvidence: requests.map(request => ({ requestId: request.requestId, evidence })) });
    const settings = accountSettingsParse({});
    const snapshot = { source: 'network' as const, settings, rawSettings: {}, ...notificationCatalogFixture(settings),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(credentials)) };
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot, serverHttpBaseUrl,
      isCurrent: async () => true });
    const settlements: SessionFollowPersonalProgressRequestV1[] = [];
    let observedRequestId: string | undefined;
    let secondRequestRouteReads = 0;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: [rule] } };
      if (path === '/v2/account/session-follow-preferences') return { status: 200,
        data: { assigned: false, direct: false, team: false, group: false } };
      if (path === `/v2/sessions/${sourceSessionId}`) return { status: 200, data: { session: source } };
      if (path === '/v2/account/session-delivery-mutes') return availability === 'unavailable-mute' && observedRequestId === 'B'
        ? { status: 409, data: { error: 'mute_state_unavailable' } } : { status: 200, data: { scopes: [] } };
      throw new Error(`Unexpected GET ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/follows/occurrence-routes')) {
        const original = SessionFollowRuleSourceOccurrenceV1Schema.parse({ ...occurrence,
          ...(typeof body === 'object' && body !== null && 'sourceRequests' in body ? { sourceRequests: body.sourceRequests } : {}) });
        observedRequestId = 'sourceRequests' in original ? original.sourceRequests.requests[0]?.requestId : undefined;
        const request = requests.find(item => item.requestId === observedRequestId)!;
        if (request.requestId === 'B') secondRequestRouteReads++;
        return availability === 'unavailable-route' && request.requestId === 'B' ? { status: 503, data: {} }
          : { status: 200, data: { ok: true, v: 1, sourceSessionId, originalCreatedAt: request.createdAt, routes: [],
              currentAccountFacts: { defaultRelationships: { assigned: false, direct: false, team: false, group: false }, hasPersistentFollow: false,
                personalFollowSuppressed: availability === 'optout-before-dispatch' && request.requestId === 'B' && secondRequestRouteReads > 1 } } };
      }
      if (path.endsWith('/personal-progress')) {
        settlements.push(SessionFollowPersonalProgressRequestV1Schema.parse(body));
        return { status: 200, data: { accepted: true, alreadyRepresented: false } };
      }
      throw new Error(`Unexpected POST ${path}`);
    });
    const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials,
      serverId: 'home', serverHttpBaseUrl, machineId: 'source-machine', installationId: 'installation',
      signal: new AbortController().signal, isCurrent: async () => true, subscribeInvalidation: () => () => {},
      resolveSourceKeyContext: async () => null, isPersonalCurrent: () => availability !== 'unavailable-personal-scope' && operationContext.isCurrent(),
      dispatchPersonal: (dispatch, isCurrent) => createPersonalFollowOccurrenceDispatcher({
        operationContext, isCurrent: () => isCurrent(),
      })(dispatch) });
    try {
      if (availability === 'optout-before-dispatch') {
        await expect(dispatcher.dispatch(occurrence)).rejects.toThrow('personal_follow_scope_retired');
        expect(settlements).toEqual([]);
        return;
      }
      const result = await dispatcher.dispatch(occurrence);
      if (availability === 'unavailable-personal-scope') {
        expect(result).toEqual({});
        expect(settlements).toEqual([]);
        return;
      }
      const eligibleRequestId = availability === 'complete' ? 'B' : 'A';
      expect(result).toMatchObject({ personalFollow: { sourceSessionId, requests: [{ requestId: eligibleRequestId,
        policies: [{ preset: 'important' }] }] } });
      if (availability === 'complete') {
        expect(result).toMatchObject({ personalFollow: { accepted: true } });
        expect(settlements).toEqual([{ sourceSessionId, expectedSourcePublisherGeneration: '1', machineId: 'source-machine',
          installationId: 'installation', sourceRequests: { agentStateVersion: 1, requests },
          rules: [{ ruleId: rule.ruleId, ruleVersion: rule.version, requestIds: ['B'] }] }]);
      } else {
        expect(result && result.personalFollow).not.toHaveProperty('accepted');
        expect(settlements).toEqual([]);
      }
    } finally { dispatcher.dispose(); }
  },
);
