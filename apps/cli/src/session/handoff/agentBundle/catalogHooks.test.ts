import { describe, expect, it, onTestFinished } from 'vitest';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';

describe('handoff provider-bundle catalog hooks', () => {
  it('extracts opaque bundle records through the admitted native handoff surface', async () => {
    const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.opencode'] } });
    onTestFinished(() => runtime.dispose());
    await runtime.registry.activateContributionsOnDemand([
      { pluginId: 'happier.agent.opencode', family: 'agents', localId: 'opencode' },
    ]);
    const surface = await getSessionHostBridge().resolveCurrentExecutionSurfacesForCatalogAgent('opencode');
    const extract = surface?.executionSurfaces.handoff?.extractMediaScannableRecords;
    expect(extract).toBeTypeOf('function');
    if (!extract) throw new Error('Missing admitted native OpenCode bundle extractor');
    const nativeExport = { id: 'native-session', messages: [{ id: 'message-1' }] };
    expect(await extract({ bundle: { agentId: 'opencode', remoteSessionId: 'ses_native',
      exportJsonBase64: Buffer.from(JSON.stringify(nativeExport)).toString('base64') } }))
      .toEqual([nativeExport, { id: 'message-1' }]);
    const withoutNativeHandoff = await getSessionHostBridge().resolveCurrentExecutionSurfacesForCatalogAgent('ohMyPi');
    expect(withoutNativeHandoff?.executionSurfaces.handoff ?? null).toBeNull();
  });
});
