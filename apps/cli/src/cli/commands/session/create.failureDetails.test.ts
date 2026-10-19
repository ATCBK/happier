import { createServer } from 'node:http';

import { expect, it } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

import { cmdSessionCreate } from './create';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';

it.each(['provider', 'agent_signed_out'] as const)('preserves the typed %s cause through public Action transport and JSON or thrown Session-create errors', async (kind) => {
  const providerError = createProviderErrorV1('provider_endpoint_unavailable', {
    connectionId: 'pc_gateway', machineId: 'machine-a',
  });
  const result = kind === 'provider'
    ? SessionSpawnNewResultV1Schema.parse({ type: 'error', code: 'spawn_failed',
        retryable: providerError.retryable, providerError })
    : SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({ errorCode: 'agent_signed_out',
        errorMessage: 'upstream-private-auth-diagnostic', agentId: 'custom-agent' }));
  const requests: string[] = [];
  // Only the remote public Action HTTP boundary is substituted. The result uses
  // its canonical schema; the SDK client and CLI strict consumer stay real.
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const { requestId } = JSON.parse(body) as { requestId?: string };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ v: 1, actionId: 'session.spawn_new', requestId,
      execution: { ok: true, result } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected Action endpoint');
  const url = `http://127.0.0.1:${address.port}`;
  const previousExitCode = process.exitCode;
  try {
    await withConfiguredDaemonTestHome({ prefix: 'session-create-cause-',
      env: { HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url } }, async () => {
      const deps = { readCredentialsFn: async () => ({
        token: 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43),
        encryption: null, credentialProvenance: 'api_token' as const,
      }) };
      const argv = ['--machine-id', 'machine-a', '--path', '/tmp'];
      const output = captureConsoleJsonOutput();
      try {
        await cmdSessionCreate([...argv, '--json'], deps);
        const expected = kind === 'provider' ? { code: 'spawn_failed', retryable: true, providerError }
          : { code: 'agent_signed_out', agentId: 'custom-agent', launchError: {
              kind: 'launch_error', code: 'agent_signed_out',
              message: expect.stringMatching(/select.*connected account profile.*configure.*default profile/i),
            } };
        expect.soft(output.json()).toMatchObject({ ok: false, kind: 'session_create', error: expected });
        await expect(cmdSessionCreate(argv, deps)).rejects.toMatchObject({ ...expected,
          ...(kind === 'agent_signed_out' ? {
            message: expect.stringMatching(/select.*connected account profile.*configure.*default profile/i),
          } : {}),
        });
        expect(requests).toEqual(['POST /v1/actions/session.spawn_new', 'POST /v1/actions/session.spawn_new']);
      } finally { output.restore(); }
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    process.exitCode = previousExitCode;
  }
});
