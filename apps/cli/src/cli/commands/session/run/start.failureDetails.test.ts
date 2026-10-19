import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ExternalActionMachineBootstrapV1Schema } from '@happier-dev/protocol/actions/externalActionApi';

import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

import { handleSessionCommand } from '../handleSessionCommand';

describe('session run start failure details through API Token transport', () => {
  let server: Server;
  let envScope: ReturnType<typeof createEnvKeyScope>;
  let runCreation: 'noRunCreated' | 'outcomeUnknown';
  let requests: string[];
  let previousExitCode: typeof process.exitCode;

  beforeEach(async () => {
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    previousExitCode = process.exitCode;
    requests = [];
    // Only the remote public Action endpoint is substituted; credentials,
    // target resolution, SDK transport and CLI result normalization stay real.
    server = createServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === 'GET' && request.url === '/v1/machines') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify([ExternalActionMachineBootstrapV1Schema.parse({
          id: 'machine-a', kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
        })]));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/actions/execution.run.start') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const { requestId } = JSON.parse(body) as { requestId?: string };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        v: 1,
        actionId: 'execution.run.start',
        requestId,
        execution: {
          ok: false,
          errorCode: 'target_unavailable',
          error: 'Target unavailable',
          details: { executionRunStart: { v: 1, runCreation } },
        },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected HTTP test endpoint');
    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = process.env.HAPPIER_SERVER_URL;
    reloadConfiguration();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    envScope.restore();
    reloadConfiguration();
    process.exitCode = previousExitCode;
  });

  it.each(['noRunCreated', 'outcomeUnknown'] as const)('preserves %s in JSON and thrown errors without retry', async (certainty) => {
    runCreation = certainty;
    const details = { executionRunStart: { v: 1, runCreation } };
    const argv = ['run', 'start', 'c123456789012345678901234', '--intent', 'review', '--agent', 'agent:happier.agent.claude/claude'];
    const deps = {
      readCredentialsFn: async () => ({
        token: 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43),
        encryption: null,
        credentialProvenance: 'api_token' as const,
      }),
    };
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand([...argv, '--json'], deps);
      expect.soft(output.json()).toMatchObject({
        ok: false,
        kind: 'session_run_start',
        error: { code: 'target_unavailable', details },
      });
      process.exitCode = undefined;
      await handleSessionCommand(argv, deps);
      expect.soft(process.exitCode).toBe(1);
      expect(requests.filter((request) => request === 'POST /v1/actions/execution.run.start')).toEqual([
        'POST /v1/actions/execution.run.start',
        'POST /v1/actions/execution.run.start',
      ]);
    } finally {
      output.restore();
    }
  });
});
