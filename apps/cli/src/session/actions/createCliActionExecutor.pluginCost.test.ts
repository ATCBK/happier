import http from 'node:http';
import { expect, it } from 'vitest';
import { reloadConfiguration } from '@/configuration';
import { writeDaemonState, clearDaemonStateForTestTeardown } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createCliActionExecutor } from './createCliActionExecutor';

it('executes plugin inventory without reading an unrelated Session workspace', async () => {
  const home = await createTempDir('happier-plugin-action-cost-');
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  const requests: string[] = [];
  // Only the daemon HTTP boundary is replaced. CLI preparation, Action policy,
  // dev-loop dispatch, control transport and result projection remain real.
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/plugins/catalog/read'
      ? { kind: 'available', plugins: [], tools: [] }
      : { kind: 'available', changes: [] }));
  });
  let workspaceReads = 0;
  try {
    env.patch({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    writeDaemonState({ pid: process.pid, httpPort: address.port, controlToken: 'test-token',
      startedAt: Date.now(), startedWithCliVersion: 'test' });
    const executor = createCliActionExecutor({ token: 'test-token', sessionId: 'cli-global', mode: 'plain', ctx: null,
      rawSession: { get path() { workspaceReads++; return '/unrelated-session'; } },
      pluginActionExecutionOwner: 'current_process' });
    for (let invocation = 0; invocation < 2; invocation++) {
      await expect(executor.execute('plugins.list', {}, { surface: 'ui', authority: 'present_user' }))
        .resolves.toMatchObject({ ok: true, result: { kind: 'plugins_list', plugins: [], pendingChanges: [] } });
    }
    expect(requests.filter(path => path === '/plugins/catalog/read')).toHaveLength(2);
    expect(requests.filter(path => path === '/plugins/change/list')).toHaveLength(2);
    expect(workspaceReads).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await clearDaemonStateForTestTeardown();
    env.restore();
    reloadConfiguration();
    await removeTempDir(home);
  }
});
