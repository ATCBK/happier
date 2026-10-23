import { expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol';
import { createAttachedManagedRunFixture } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';
import { writeStoredCredentialsForServerId } from '@/persistence';

it('uses the current Machine Home binding without a full feature refresh for an unsigned Action', async () => {
  let featureReads = 0;
  const homeId = 'home';
  const fixture = await createAttachedManagedRunFixture({ browserStartup: {
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
    resolveServerFeaturesSnapshot: async () => {
      featureReads++;
      return { status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
        capabilities: { serverIdentity: { serverIdentityId: homeId } },
      }) };
    },
  } });
  vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
  try {
    await writeStoredCredentialsForServerId('home', fixture.credentials);
    const executor = fixture.control?.externalActionApi?.executor;
    if (!executor) throw new Error('Expected genuine daemon Action ingress');
    // The fixture replaces HTTP/OS boundaries; daemon composition, credentialed
    // factory, approval enrichment, policy and Protocol execution remain real.
    const before = featureReads;
    for (const id of [homeId, homeId]) {
      const result = await executor.execute('action.spec.get', { id: 'session.list' }, {
        surface: 'cli', authority: 'present_user', defaultSessionId: 'parent-session', serverIdentityId: 'untrusted-caller-home',
      });
      if (!result.ok) throw new Error(result.errorCode);
      const catalog = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(result.result);
      expect(catalog.invocationContext?.widgetSurface?.serverId).toBe(id);
    }
    expect(featureReads - before).toBe(0);
  } finally {
    vi.unstubAllEnvs();
    await fixture.cleanup();
  }
});
