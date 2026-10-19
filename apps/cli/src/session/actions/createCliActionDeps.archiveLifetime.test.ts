import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from './createCliActionDeps';

it.each(['session.archive', 'session.unarchive'] as const)(
  'carries %s Action cancellation through its real service and HTTP request', async actionId => {
    const sessionId = 'c' + 'a'.repeat(24);
    const controller = new AbortController();
    let admit!: () => void;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    let requestClosed = false;
    let reply!: () => void;
    const server = createServer((request, response) => {
      request.resume();
      if (request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ session: createSessionRecordFixture({
          id: sessionId, active: false, encryptionMode: 'plain', metadata: '{}',
        }) }));
        return;
      }
      expect(request.url).toBe(`/v2/sessions/${sessionId}/${actionId === 'session.archive' ? 'archive' : 'unarchive'}`);
      reply = () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true, archivedAt: actionId === 'session.archive' ? 123 : null }));
      };
      response.on('close', () => { requestClosed = true; });
      admit();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture address');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const credentials = { token: 'fixture-token', encryption: null };
      const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
        sessionId, serverId: 'fixture-home', serverHttpBaseUrl: origin, mode: 'plain', ctx: null }));
      const result = runWithServerHttpBaseUrl(origin, () => executor.execute(actionId, { sessionId }, {
        surface: 'cli', authority: 'present_user', serverId: 'fixture-home', actionCaller: { kind: 'host' },
        signal: controller.signal,
        actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
          'session.archive': ['cli'], 'session.unarchive': ['cli'],
        } }),
      }));
      await expect(Promise.race([admitted.then(() => 'admitted'), result])).resolves.toBe('admitted');
      controller.abort();
      // Release the fixture only after checking that cancellation closes the real
      // request. This fails if any factory/service hunk drops the caller signal.
      await expect.poll(() => requestClosed).toBe(true);
      await expect(result).resolves.toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    } finally {
      reply?.();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  },
);
