import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { configuration, reloadConfiguration } from '@/configuration';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createDaemonExternalActionTargetResolver } from './externalActions/daemonExternalActionTargetResolver';
import { createDaemonControlApp } from './controlServer';

describe('signed root plugin install placement', () => {
  afterEach(() => { vi.unstubAllEnvs(); reloadConfiguration(); });

  it('executes at the receiving daemon instead of re-entering original CLI delivery', async () => {
    const taskRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-install-routing-'));
    vi.stubEnv('HAPPIER_HOME_DIR', taskRoot);
    reloadConfiguration();
    const serverId = 'plugin-install-home';
    const machineId = 'plugin-install-machine';
    const accountId = 'plugin-install-account';
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const credentials = { token: `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: accountId,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`,
      encryption: null, credentialProvenance: 'stored_session' } as const;
    const controlToken = 'plugin-install-test-control';
    const upstreamPaths: string[] = [];
    // The fixture supplies only network/OS publication facts. Admission,
    // target resolution, credentials, executor and plugin action remain real.
    const settings = createActionSettingsProvider({ scopeKey: 'plugin-install-routing', accountSettings: accountSettingsParse({
      actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'plugins.install': ['cli'] } },
    }) });
    let observeSessionRead!: () => void;
    const sessionRead = new Promise<'session_read'>(resolve => { observeSessionRead = () => resolve('session_read'); });
    let heldSessionResponse: ServerResponse | undefined;
    const home = createServer((request, response) => {
      if (request.url === '/v1/account/encryption/currentness') {
        heldSessionResponse = response;
        observeSessionRead();
        return;
      }
      response.writeHead(503).end();
    });
    await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
    const homeAddress = home.address();
    if (!homeAddress || typeof homeAddress === 'string') throw new Error('Missing Home listener');
    const homeUrl = `http://127.0.0.1:${homeAddress.port}`;
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId,
      serverApiUrl: homeUrl, serverIdentityId: 'srv_plugin_install',
      pluginActionExecutionOwner: 'current_process', actionsSettingsProvider: settings });
    const app = createDaemonControlApp({ getChildren: () => [], machineId, controlToken,
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => { throw new Error('Unexpected Session spawn'); },
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
      externalActionApi: { currentServerId: serverId, currentAccountId: accountId, executor,
        verifyPat: async () => { throw new Error('Signed root does not verify a PAT'); },
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: homeUrl }),
      },
    });
    let rootRequests = 0;
    app.addHook('preHandler', async (request, reply) => {
      upstreamPaths.push(request.url);
      if (request.url === '/actions/root/execute' && ++rootRequests > 1) {
        return reply.send({ ok: false, errorCode: 'root_action_reentered', error: 'root_action_reentered' });
      }
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Missing control listener');
      const serverDir = join(configuration.serversDir, serverId);
      await mkdir(serverDir, { recursive: true });
      await writeFile(join(serverDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid,
        httpPort: address.port, controlToken, machineId, accountId, startedAt: Date.now(), startedWithCliVersion: 'test' }));
      const execution = app.inject({ method: 'POST', url: '/actions/root/execute',
        headers: { 'x-happier-daemon-token': controlToken }, payload: {
          actionId: 'plugins.install', actionRequestId: 'one-plugin-install',
          target: { kind: 'machine', machineId },
          input: { path: 'happier-plugin-qa-capabilities', kind: 'npm', dryRun: true },
        } });
      // A global npm install must complete while unrelated Session metadata is
      // unavailable. Real HTTP holds that boundary; no internal resolver is mocked.
      const first = await Promise.race([execution.then(() => 'completed' as const), sessionRead]);
      if (heldSessionResponse && !heldSessionResponse.writableEnded) heldSessionResponse.writeHead(503).end();
      const response = await execution;
      expect(first).toBe('completed');
      expect(rootRequests, JSON.stringify(response.json())).toBe(1);
      expect(response.json(), JSON.stringify(response.json())).toMatchObject({ ok: true, result: { ok: true, kind: 'plugins_install', dryRun: true,
        request: { kind: 'installNpm', packageName: 'happier-plugin-qa-capabilities' } } });
      expect(upstreamPaths.filter(path => path === '/actions/root/execute')).toHaveLength(1);
    } finally {
      if (heldSessionResponse && !heldSessionResponse.writableEnded) heldSessionResponse.writeHead(503).end();
      await app.close();
      home.closeAllConnections();
      await new Promise<void>(resolve => home.close(() => resolve()));
      await rm(taskRoot, { recursive: true, force: true });
    }
  });
});
