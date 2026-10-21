import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionFollowOccurrenceDispatcher } from './sessionFollowOccurrenceDispatcher';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { SessionFollowInputV1Schema, deriveSessionFollowInputLocalIdV1, resolveExecutionRunFollowOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { RunFollowOriginalV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { resolveWorkflowRunFollowEventV1 } from '@happier-dev/protocol/workflows/composeWorkflowRunWorkerUpdateV1';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { createWorkflowRunStorageClient } from '@/daemon/workflows/workflowRunStorageClient';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { SessionFollowRunOccurrenceSchema } from '@/daemon/sessions/sessionActivityChangedContract';
import * as daemonTransport from '@/daemon/controlHttp';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['execution_run', 'notification', 'finished'], ['workflow_run', 'notification', 'finished'],
  ['execution_run', 'catchup', 'finished'], ['workflow_run', 'catchup', 'finished'],
  ['workflow_run', 'notification', 'needs_you'], ['workflow_run', 'notification', 'update_posted'],
  ['workflow_run', 'catchup', 'needs_you'], ['workflow_run', 'catchup', 'update_posted'],
  ['execution_run', 'notification', 'needs_you'], ['execution_run', 'catchup', 'needs_you'],
] as const)('delivers one %s original through existing Pending on %s for %s, keeping mute and replay idempotent', async (kind, entry, eventKind) => {
  const destinationSessionId = 'c222222222222222222222222';
  const permissionOccurrence = kind === 'execution_run' && eventKind === 'needs_you'
    ? resolveExecutionRunFollowOccurrenceV1({ sessionId: 'c111111111111111111111111', runId: 'run-one',
      status: 'running', terminalEventId: null, attention: { kind: 'permission_required', requestIds: ['permission-one'],
        requests: [{ requestId: 'permission-one', createdAt: 1 }] } }) : null;
  if (kind === 'execution_run' && eventKind === 'needs_you') expect(permissionOccurrence?.event).toEqual({ kind: 'needs_you', type: 'approval' });
  const original: RunFollowOriginalV1 = kind === 'execution_run'
    ? permissionOccurrence?.original ?? { source: { kind, sessionId: 'c111111111111111111111111', runId: 'run-one' }, terminalEventId: 'terminal-one' }
    : { source: { kind, runId: 'workflow-one' }, revision: 4 };
  const source = original.source;
  const boundary = createWorkflowRunStorageTestkit({ runId: 'workflow-one', machineId: 'source-machine',
    origin: { kind: 'direct' }, state: eventKind === 'finished' ? 'succeeded' : 'running' });
  const workflow = WorkflowRunSummaryV1Schema.parse({ ...boundary.run(), revision: 4,
    attentionRequired: eventKind === 'needs_you' });
  const event = kind === 'execution_run' ? permissionOccurrence?.event ?? { kind: 'finished' as const } : resolveWorkflowRunFollowEventV1(workflow)!;
  const policy = { preset: permissionOccurrence ? 'important' as const : 'quiet' as const };
  const occurrence = SessionFollowRunOccurrenceSchema.parse({ original, event });
  const sourceRow = { ...createSessionNotificationContextFixture(destinationSessionId), ownerAccountId: 'account-1',
    encryptionMode: 'plain', dataEncryptionKey: null, archivedAt: null, active: true,
    metadata: JSON.stringify({ path: '/work', host: 'host', machineId: 'receiver-machine' }) };
  const pending = new Map<string, unknown>();
  let muted = true;
  let routePresent = true;
  let returnDifferentOriginal = false;
  let sourceCurrent = true;
  const replacementOriginal: RunFollowOriginalV1 = 'terminalEventId' in original
    ? { ...original, terminalEventId: 'replacement-terminal' }
    : 'permissionRequests' in original ? { ...original, permissionRequests: [{ requestId: 'permission-one', createdAt: 2 }] }
    : { ...original, revision: original.revision + 1 };
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    if (path.endsWith('/follows/sessions')) return { status: 200, data: { sources: [{ source, destinationSessionId,
      relation: 'follower', policy, deliveryState: 'eligible', sourceAvailability: 'available', hasPendingUpdates: true }] } };
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
    if (path === '/v3/automations/runs/workflow-storage') return { status: 200, data: workflow };
    if (path.endsWith('/run-occurrence-routes') && !sourceCurrent) return { status: 200, data: { ok: false, v: 1, error: 'source_unavailable' } };
    if (path.endsWith('/run-occurrence-routes')) return { status: 200, data: { ok: true, v: 1,
      original: returnDifferentOriginal ? replacementOriginal : original, event: occurrence.event,
      routes: routePresent ? [{ destinationSessionId, relation: 'follower', attachedAt: 1, policy,
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
    const hints: Promise<unknown>[] = [];
    vi.spyOn(daemonTransport, 'daemonPost').mockImplementation(async (_path, body) => {
      if (!body || typeof body !== 'object' || !('followOccurrence' in body)) throw new Error('Missing original hint');
      hints.push(dispatcher.dispatch(SessionFollowRunOccurrenceSchema.parse(body.followOccurrence)));
      return { ok: true };
    });
    const client = createWorkflowRunStorageClient({ token: 'token', machineId: 'source-machine',
      serverHttpBaseUrl: 'http://run-follow.test', createPublisherHeader: async () => 'signed-publisher' });
    const deliver = async () => {
      if (entry === 'catchup') return dispatcher.dispatchReceiverRange({ destinationSessionId, observations: [] });
      if (kind === 'execution_run') return dispatcher.dispatch(occurrence);
      await client.execute({ operation: 'transition', runId: workflow.id });
      await Promise.all(hints.splice(0));
    };
    await deliver();
    expect(pending.size).toBe(0);
    muted = false;
    if (permissionOccurrence) {
      sourceCurrent = false;
      await deliver();
      expect(pending.size).toBe(0);
      sourceCurrent = true;
    }
    if (entry === 'notification') {
      returnDifferentOriginal = true;
      await deliver();
      expect(pending.size).toBe(0);
      returnDifferentOriginal = false;
    }
    await deliver();
    expect(pending.size).toBe(1);
    const localId = deriveSessionFollowInputLocalIdV1({ destinationSessionId, original });
    expect(pending.has(localId)).toBe(true);
    expect(JSON.stringify(pending.get(localId))).toContain(JSON.stringify(SessionFollowInputV1Schema.parse({ v: 1, original,
      event: occurrence.event, delivery: permissionOccurrence ? 'wake' : 'next_turn' })));
    await deliver();
    expect(pending.size).toBe(1);
    routePresent = false;
    await deliver();
    expect(pending.size).toBe(1);
  } finally { dispatcher.dispose(); }
});
