import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionFollowOccurrenceDispatcher } from './sessionFollowOccurrenceDispatcher';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { SessionFollowInputV1Schema, deriveSessionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { RunFollowOriginalV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['execution_run', 'notification'], ['workflow_run', 'notification'],
  ['execution_run', 'catchup'], ['workflow_run', 'catchup'],
] as const)('delivers one %s terminal original through existing Pending on %s, keeping mute and replay idempotent', async (kind, entry) => {
  const destinationSessionId = 'c222222222222222222222222';
  const original: RunFollowOriginalV1 = kind === 'execution_run'
    ? { source: { kind, sessionId: 'c111111111111111111111111', runId: 'run-one' }, terminalEventId: 'terminal-one' }
    : { source: { kind, runId: 'workflow-one' }, revision: 4 };
  const source = original.source;
  const occurrence = { original, event: { kind: 'finished' as const } };
  const sourceRow = { ...createSessionNotificationContextFixture(destinationSessionId), ownerAccountId: 'account-1',
    encryptionMode: 'plain', dataEncryptionKey: null, archivedAt: null, active: true,
    metadata: JSON.stringify({ path: '/work', host: 'host', machineId: 'receiver-machine' }) };
  const pending = new Map<string, unknown>();
  let muted = true;
  let routePresent = true;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    if (path.endsWith('/follows/sessions')) return { status: 200, data: { sources: [{ source, destinationSessionId,
      relation: 'follower', policy: { preset: 'important' }, deliveryState: 'eligible', sourceAvailability: 'available', hasPendingUpdates: true }] } };
    if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: [] } };
    if (path === '/v2/account/session-follow-preferences') return { status: 200,
      data: { assigned: false, direct: false, team: false, group: false } };
    if (path.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: muted ? [{ kind: 'source', source }] : [] } };
    if (path === `/v2/sessions/${destinationSessionId}`) return { status: 200, data: { session: sourceRow } };
    if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200, data: { sessions: [], hasNext: false, nextCursor: null } };
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/run-occurrence-routes')) return { status: 200, data: { ok: true, v: 1, original, event: occurrence.event,
      routes: routePresent ? [{ destinationSessionId, relation: 'follower', attachedAt: 1, policy: { preset: 'important' },
        ...(kind === 'execution_run' ? { expectedTerminalEventId: null } : { expectedRevision: 3 }) }] : [] } };
    if (path === '/v2/sessions/lookup-by-tags') return { status: 200, data: { sessions: [] } };
    if (path.endsWith('/pending')) {
      if (typeof body !== 'object' || body === null || !('localId' in body) || typeof body.localId !== 'string') throw new Error('Missing Pending identity');
      pending.set(body.localId, body);
      return { status: 200, data: { didWrite: true, message: { localId: body.localId, seq: 1 } } };
    }
    throw new Error(`Unexpected POST ${path}`);
  });
  const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: { token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null },
    serverId: 'home', serverHttpBaseUrl: 'http://run-follow.test', machineId: 'receiver-machine', installationId: 'installation',
    signal: new AbortController().signal, isCurrent: async () => true, subscribeInvalidation: () => () => {},
    resolveSourceKeyContext: async () => null, isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
  try {
    const deliver = () => entry === 'notification' ? dispatcher.dispatch(occurrence)
      : dispatcher.dispatchReceiverRange({ destinationSessionId, observations: [] });
    await deliver();
    expect(pending.size).toBe(0);
    muted = false;
    await deliver();
    expect(pending.size).toBe(1);
    const localId = deriveSessionFollowInputLocalIdV1({ destinationSessionId, original });
    expect(pending.has(localId)).toBe(true);
    expect(JSON.stringify(pending.get(localId))).toContain(JSON.stringify(SessionFollowInputV1Schema.parse({ v: 1, original,
      event: occurrence.event, delivery: 'next_turn' })));
    await deliver();
    expect(pending.size).toBe(1);
    routePresent = false;
    await deliver();
    expect(pending.size).toBe(1);
  } finally { dispatcher.dispose(); }
});
