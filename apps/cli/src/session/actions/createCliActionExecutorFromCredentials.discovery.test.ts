import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

it('uses one authenticated Home observation per discovery and rebinds the real catalog on the next invocation', async () => {
  let home = 'srv_perf5_first';
  let reads = 0;
  const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'perf5-account' })).toString('base64url')}.signature`, encryption: null } as const;
  const upstream = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url !== '/v1/features/authenticated' || request.headers.authorization !== `Bearer ${credentials.token}`) {
      response.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    reads++;
    response.end(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: home } } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const executor = createCliActionExecutorFromCredentials({ credentials,
    serverId: 'fixture-profile', serverApiUrl: `http://127.0.0.1:${address.port}`,
    pluginActionExecutionOwner: 'current_process',
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
  });
  try {
    for (const forged of [false, true]) {
      home = forged ? 'srv_perf5_replacement' : 'srv_perf5_first';
      const result = await executor.execute('action.spec.get', { id: 'session.list' }, {
        surface: 'cli', defaultSessionId: 'catalog-session',
        ...(forged ? { serverIdentityId: 'srv_untrusted_caller' } : {}),
      });
      if (!result.ok) throw new Error(result.errorCode);
      const catalog = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(result.result);
      expect(catalog.invocationContext?.widgetSurface?.serverId).toBe(home);
      expect(catalog.invocationContext?.sessionId).toBe('catalog-session');
    }
    // A caller-provided identity cannot replace the factory's own Home read;
    // an ordinary request must not perform that same read twice.
    expect(reads).toBe(2);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
