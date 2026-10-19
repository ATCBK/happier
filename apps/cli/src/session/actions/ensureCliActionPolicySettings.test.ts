import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { ACCOUNT_SECURITY_PATH_V1 } from '@happier-dev/protocol/auth/accountSecurity';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { ensureCliActionPolicySettings } from './ensureCliActionPolicySettings';

afterEach(() => { vi.unstubAllEnvs(); resetInMemoryAccountSettingsContextForTests(); });

it('loads independent Settings while security is pending and joins both before root authority admission', async () => {
  resetInMemoryAccountSettingsContextForTests();
  vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
  vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
  let releaseSecurity!: () => void;
  let securityRequested!: () => void;
  let settingsRequested = false;
  let unexpectedWrite = false;
  const securityAccepted = new Promise<void>(resolve => { securityRequested = resolve; });
  const upstream = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === ACCOUNT_SECURITY_PATH_V1) {
      releaseSecurity = () => response.end(JSON.stringify({ v: 1, encryptionMode: 'plain', nativeEmail: null,
        password: { status: 'not_enrolled', revision: null }, terminalPresentUserPolicy: 'disallowed' }));
      securityRequested();
    } else if (request.url === '/v2/account/settings') {
      settingsRequested = true;
      response.end(JSON.stringify({ version: 1, content: { t: 'plain', v: { workDepthLimit: 4 } } }));
    } else {
      unexpectedWrite ||= request.method !== 'GET';
      response.writeHead(404).end(JSON.stringify({ error: 'unexpected_request' }));
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
  const credentials = { token: `perf5-policy-${address.port}`, encryption: null } as const;
  let completed = false;
  const prepared = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => ensureCliActionPolicySettings(credentials, serverHttpBaseUrl))
    .then(() => { completed = true; });
  const app = createDaemonControlApp({
    getChildren: () => [], machineId: 'policy-machine', controlToken: 'fixture-control-token',
    stopSession: async () => { throw new Error('Unexpected process stop'); },
    spawnSession: async () => { throw new Error('Unexpected process spawn'); },
    requestShutdown: () => { throw new Error('Unexpected process shutdown'); }, onHappySessionWebhook: () => {},
    externalActionApi: {
      currentServerId: 'policy-home', terminalPolicyScope: { token: credentials.token, serverHttpBaseUrl },
      verifyPat: async () => { throw new Error('Root ingress must not use PAT verification'); },
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl }),
      executor: createCliActionExecutorFromCredentials({ credentials, serverId: 'policy-home', serverIdentityId: 'policy-home',
        serverApiUrl: serverHttpBaseUrl, pluginActionExecutionOwner: 'current_process' }),
    },
  });
  let rootSettled = false;
  const invoke = () => app.inject({ method: 'POST', url: '/actions/root/execute',
    headers: { 'x-happier-daemon-token': 'fixture-control-token' },
    payload: { actionId: 'approval.request.decide', input: { artifactId: 'missing', decision: 'approve' } },
  }).then(response => { rootSettled = true; return response; });
  try {
    await securityAccepted;
    const pendingRoot = invoke();
    try {
      await vi.waitFor(() => expect(settingsRequested).toBe(true));
      await vi.waitFor(() => expect(getActiveAccountSettingsSnapshot()?.settings.workDepthLimit).toBe(4));
      expect(completed).toBe(false);
      expect(rootSettled).toBe(false);
    } finally { releaseSecurity(); await prepared; }
    const response = await pendingRoot;
    expect(response.json()).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(unexpectedWrite).toBe(false);
  } finally {
    releaseSecurity?.();
    await prepared;
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
