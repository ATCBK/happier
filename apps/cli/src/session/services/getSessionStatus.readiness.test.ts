import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionStatusResultSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { getSessionStatus } from './getSessionStatus';
import * as sessionSockets from '@/api/session/sockets';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';

afterEach(() => { vi.restoreAllMocks(); });

it('never widens a protected status read to a live socket using the host token', async () => {
  const sessionId = 'c123456789012345678901234';
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
    accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
    machineId: 'machine', custodianAccountId: 'host', installationId: 'installed',
    actionId: 'session.status.get', requestId: 'status', requestEnvelopeDigest: 'a'.repeat(43),
    target: { kind: 'session', sessionId },
  } });
  const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}' });
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    expect(config?.headers?.Authorization).toBe('Bearer requester-bound-read');
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
    throw new Error(`Unexpected HTTP read ${path}`);
  });
  const socket = vi.spyOn(sessionSockets, 'createSessionScopedSocket').mockImplementation(() => {
    throw new Error('An unscoped live socket must not be opened');
  });
  expect(await getSessionStatus({ credentials: { token: 'host-token', encryption: null },
    idOrPrefix: sessionId, live: true, authorization,
    resolveAuthorizationHeaders: () => ({ Authorization: 'Bearer requester-bound-read' }),
  })).toMatchObject({ ok: true, session: { id: sessionId } });
  expect(socket).not.toHaveBeenCalled();
});

it.each([true, false])('distinguishes saved setup from current invocation permission (%s)', async allowed => {
  const sessionId = 'c123456789012345678901234';
  const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
    metadata: JSON.stringify({ machineId: 'machine-1', flavor: 'codex', path: '/workspace' }),
    effectiveAccess: { v: 1, level: allowed ? 'owner' : 'view', sources: [],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: allowed, grants: [] }) } });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
    throw new Error(`Unexpected HTTP read ${path}`);
  });
  const result = await getSessionStatus({ credentials: { token: 'token', encryption: null },
    idOrPrefix: sessionId, live: false, readiness: true });
  expect(result).toMatchObject({ ok: true, readiness: { v: 1, configured: true,
    status: allowed ? 'unknown' : 'unavailable', cause: allowed ? 'machine' : 'invocation',
    invocation: { capabilities: { submitAgentInput: allowed } },
    machine: { status: 'unknown', machineId: 'machine-1' }, agent: null,
    credential: { kind: 'not_required' } } });
  if (result.ok) expect(SessionStatusResultSchema.parse(result)).toEqual(result);
});

it('does not acquire inventory when readiness was not requested', async () => {
  const sessionId = 'c123456789012345678901234';
  const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}' });
  const requests: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
    throw new Error(`Unexpected HTTP read ${path}`);
  });
  const result = await getSessionStatus({ credentials: { token: 'token', encryption: null }, idOrPrefix: sessionId, live: false });
  expect(result.ok).toBe(true);
  expect(result).not.toHaveProperty('readiness');
  expect(requests.sort()).toEqual(['/v1/account/encryption/currentness', `/v2/sessions/${sessionId}`].sort());
});
