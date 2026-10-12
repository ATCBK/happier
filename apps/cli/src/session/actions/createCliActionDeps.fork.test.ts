import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionForkRpcParamsSchema } from '@happier-dev/protocol/sessions/fork';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

it('forks through the receiving Machine’s strict versioned request boundary', async () => {
  const sessionId = 'cmv4ztyai00jvm2gbz2hkfqyk';
  const machineId = 'machine-source';
  const row = {
    ...createSessionNotificationContextFixture(sessionId),
    encryptionMode: 'plain' as const,
    metadata: JSON.stringify({ machineId, path: '/repo' }),
  };
  // HTTP and the receiving Machine process are genuine system boundaries.
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (String(url).endsWith('/v1/account/encryption/currentness')) {
      return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    }
    if (String(url).includes(`/v2/sessions/${sessionId}`)) {
      return { status: 200, data: { session: row } };
    }
    throw new Error(`Unexpected HTTP request: ${String(url)}`);
  });
  const deps = createCliActionDeps({
    token: 'token_test', credentials: { token: 'token_test', encryption: null },
    sessionId, mode: 'plain', ctx: null,
    machineActionDirectTargetTransport: {
      machineId,
      invoke: async (_method, request) => {
        const parsed = SessionForkRpcParamsSchema.safeParse(request);
        return parsed.success
          ? { ok: true, childSessionId: 'session-child' }
          : { ok: false, errorCode: 'INVALID_REQUEST' };
      },
    },
  });
  await expect(deps.sessionFork({ sessionId, forkPoint: { type: 'latest' }, strategy: 'replay' }))
    .resolves.toEqual({ ok: true, childSessionId: 'session-child' });
});
