import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureSessionMachineAccessKeyBinding } from './ensureSessionMachineAccessKeyBinding';
import { readHttpStatus } from '@/api/client/httpStatusError';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { reportSessionRunnerFailure } from '@/cli/resolveSessionRunnerFailureExitCode';
import { logger } from '@/ui/logger';
import { ConnectedServiceCredentialHttpClient } from '@/api/client/connectedServiceCredentialApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

describe('access-key bootstrap Home failure seam', () => {
  afterEach(() => vi.restoreAllMocks());

  it('retains Account-mode preflight HTTP 500 for machine bootstrap without caching unknown as a key failure', async () => {
    let unavailable = true;
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(unavailable ? 500 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(unavailable ? { error: 'PRIVATE_RESPONSE' } : { mode: 'plain', updatedAt: 1 }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected test Home listener');
    try {
      await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
        const api = new ConnectedServiceCredentialHttpClient({ token: 'PRIVATE_TOKEN' });
        await expect(api.getAccountEncryptionMode()).resolves.toBe('unknown');
        const failure: unknown = await api.getAccountEncryptionMode({ throwOnTransportError: true })
          .catch((error: unknown) => error);
        expect(readHttpStatus(failure)).toBe(500);
        expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failure }))
          .toMatchObject({ code: 'preparation_pending', source: 'dependency_failure' });
        unavailable = false;
        await expect(api.getAccountEncryptionMode({ throwOnTransportError: true })).resolves.toBe('plain');
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each(['GET', 'POST'] as const)('preserves a %s HTTP 500 for supervised preparation recovery and rejoins the same binding', async failingMethod => {
    let unavailable = true;
    let bound = false;
    const requests: string[] = [];
    const server = createServer((request, response) => {
      request.resume();
      requests.push(`${request.method} ${request.url}`);
      const fail = unavailable && request.method === failingMethod;
      response.writeHead(fail ? 500 : 200, { 'content-type': 'application/json' });
      if (!fail && request.method === 'POST') bound = true;
      response.end(JSON.stringify(fail ? { error: 'PRIVATE_RESPONSE' }
        : request.method === 'GET' ? { accessKey: bound ? { id: 'existing' } : null } : { success: true }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected test Home listener');
    const input = { serverUrl: `http://127.0.0.1:${address.port}`, token: 'PRIVATE_TOKEN',
      sessionId: `session-${failingMethod}`, machineId: 'machine-bootstrap' };
    const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
    try {
      const failure: unknown = await ensureSessionMachineAccessKeyBinding(input).catch((error: unknown) => error);
      expect(readHttpStatus(failure)).toBe(500);
      const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failure }));
      expect(issue).toMatchObject({ code: 'preparation_pending', source: 'dependency_failure' });
      expect(JSON.stringify(issue)).not.toMatch(/PRIVATE|127\.0\.0\.1/);
      expect(reportSessionRunnerFailure(failure)).toBe(1);
      expect(fatal).not.toHaveBeenCalled();
      unavailable = false;
      await ensureSessionMachineAccessKeyBinding(input);
      expect(bound).toBe(true);
      expect(new Set(requests.map(request => request.split(' ')[1]))).toEqual(new Set([
        `/v1/access-keys/${input.sessionId}/${input.machineId}`,
      ]));
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
