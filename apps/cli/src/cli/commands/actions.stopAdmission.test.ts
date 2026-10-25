import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { SignedRootActionExecuteRequestSchema, SIGNED_ROOT_ACTION_EXECUTE_PATH } from '@/daemon/externalActions/signedRootActionControl';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { handleActionsCommand } from './actions';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

it('admits exact Stop targets without opening Session content and preserves receiving authorization', async () => {
  const sessionId = 'c123456789012345678901234';
  const requests: string[] = [];
  const received: unknown[] = [];
  let denyStop = false;
  const server = createServer((request, response) => {
    void (async () => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('content-type', 'application/json');
      // Original CLI invocation derives the owning Machine from the exact Session's
      // Home record and Account currentness; it never reads Session content.
      if (request.url === '/v1/features/authenticated') {
        response.end(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'stop-home-identity' } } }));
        return;
      }
      if (request.url === '/v1/account/encryption/currentness') {
        response.end(JSON.stringify(createAccountEncryptionCurrentnessFixture({ mode: 'plain' })));
        return;
      }
      if (request.url?.startsWith(`/v2/sessions/${sessionId}?`) || request.url === `/v2/sessions/${sessionId}`) {
        response.end(JSON.stringify({ session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
          metadata: JSON.stringify({ machineId: 'own-machine', path: '/repo' }) }) }));
        return;
      }
      if (request.url !== SIGNED_ROOT_ACTION_EXECUTE_PATH) {
        response.writeHead(403);
        response.end(JSON.stringify({ error: 'Session content is unavailable' }));
        return;
      }
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const input = SignedRootActionExecuteRequestSchema.parse(JSON.parse(body));
      received.push(input);
      expect(request.headers['x-happier-daemon-token']).toBe('own-daemon-control');
      response.end(JSON.stringify(denyStop
        ? { ok: false, errorCode: 'permission_denied', error: 'permission_denied' }
        : { ok: true, result: { ok: true, sessionId, stopped: true } }));
    })().catch(error => {
      response.writeHead(500);
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP fixture');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_TOKEN']);
  try {
    await withTempDir('happier-stop-admission-', async homeDir => {
      env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: endpoint, HAPPIER_WEBAPP_URL: endpoint, HAPPIER_TOKEN: undefined });
      reloadConfiguration();
      await mkdir(join(homeDir, 'servers', 'stop-home'), { recursive: true });
      await writeFile(join(homeDir, 'servers', 'stop-home', 'daemon.state.json'), JSON.stringify({
        pid: process.pid, httpPort: address.port, startedAt: Date.now(), startedWithCliVersion: 'test',
        machineId: 'own-machine', accountId: 'owner', controlToken: 'own-daemon-control',
      }));
      const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', session: 'terminal-enrollment',
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
      const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
      const profile = { id: 'stop-home', name: 'Stop Home', serverUrl: endpoint, webappUrl: endpoint,
        createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact' as const,
        homeConnectionDescriptor: { v: 1 as const, homeServerIdentityId: 'stop-home-identity', canonicalServerUrl: endpoint,
          revision: 1, endpoints: [{ kind: 'https' as const, url: endpoint }] } };
      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
        output += String(chunk);
        const callback = args.find(argument => typeof argument === 'function');
        if (typeof callback === 'function') callback();
        return true;
      });
      const invoke = async (selector: string) => {
        output = '';
        process.exitCode = undefined;
        await handleActionsCommand(['invoke', 'session.stop', '--input-json', JSON.stringify({ sessionId: selector }),
          '--server-id', profile.id, '--machine-id', 'own-machine', '--json'], {
          readCredentialsFn: async () => credentials,
          readCredentialsForServerIdFn: async () => credentials,
          getServerProfileFn: async () => profile,
          createExecutorFn: createCliActionExecutorFromCredentials,
        });
        return JSON.parse(output) as unknown;
      };
      const first = await invoke(sessionId);
      expect(first, JSON.stringify({ first, requests })).toMatchObject({ ok: true, data: { sessionId, stopped: true } });
      expect(requests.filter(request => request.includes('/messages'))).toEqual([]);
      expect(requests.filter(request => request.startsWith('POST'))).toEqual([`POST ${SIGNED_ROOT_ACTION_EXECUTE_PATH}`]);
      expect(received).toEqual([expect.objectContaining({ actionId: 'session.stop', input: { sessionId },
        target: { kind: 'machine', machineId: 'own-machine' } })]);
      denyStop = true;
      expect(await invoke(` ${sessionId} `)).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
      expect(received).toHaveLength(2);
      for (const selector of ['c1234567', 'my-session-tag']) {
        expect(await invoke(selector)).toMatchObject({ ok: false });
        expect(received).toHaveLength(2);
      }
      const requestCount = requests.length;
      expect(await invoke('')).toMatchObject({ ok: false });
      expect(requests).toHaveLength(requestCount);
    });
  } finally {
    env.restore();
    reloadConfiguration();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
