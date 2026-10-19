import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { SessionStatusActionResultV1Schema } from '@happier-dev/protocol/sessions/control/contract';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { getStorage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const initial = getStorage().getState();
beforeEach(async () => { await homes.reset(); });
afterEach(() => { getStorage().setState(initial, true); standardCleanup(); });

it('reads configured versus denied invocation through the registered exact-Home status Action without Machine work', async () => {
  const serverId = await homes.addHome({ name: 'Readiness', serverUrl: 'https://readiness.test', accountId: 'alice', currentAccount: true });
  const session = createSessionFixture({ id: 'status-session', encryptionMode: 'plain', access: createSessionAccessFixture('view') });
  homes.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
  const result = await createDefaultActionExecutor().execute('session.status.get', { sessionId: session.id, readiness: true },
    { surface: 'ui', serverId, expectedAccountId: 'alice' });
  expect(result).toMatchObject({ ok: true, result: { session: { id: session.id },
    readiness: { v: 1, configured: true, status: 'unavailable', cause: 'invocation' } } });
  if (result.ok) expect(SessionStatusActionResultV1Schema.parse(result.result)).toEqual(result.result);
  expect(homes.requests.filter(request => request.path.startsWith('/v1/machines'))).toHaveLength(0);
});

it('retains the requested credential operation without borrowing the viewing Account setup', async () => {
  const serverId = await homes.addHome({ name: 'Readiness', serverUrl: 'https://readiness.test', accountId: 'bob', currentAccount: true });
  const session = createSessionFixture({ id: 'shared-bot', encryptionMode: 'plain', access: createSessionAccessFixture('view') });
  homes.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
  const result = await createDefaultActionExecutor().execute('session.status.get', { sessionId: session.id, readiness: true,
    operation: 'credential', credentialPurpose: { consumer: { pluginId: 'acme.external', localId: 'helper' }, purpose: 'outside-write' } },
  { surface: 'ui', serverId, expectedAccountId: 'bob' });
  expect(result).toMatchObject({ ok: true, result: { readiness: {
    operation: 'credential', credential: { kind: 'unknown' }, status: 'unavailable', cause: 'invocation',
  } } });
  if (result.ok) expect(SessionStatusActionResultV1Schema.parse(result.result)).toEqual(result.result);
  expect(homes.requests.filter(request => request.path === '/v1/account/profile')).toHaveLength(0);
});
