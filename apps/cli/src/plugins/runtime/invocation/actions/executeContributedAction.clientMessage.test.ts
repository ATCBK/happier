import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { UiContributedActionExecuteRequestV1Schema } from '@happier-dev/protocol/plugins/actions/clientInvocationV1';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-triage/manifest';

import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCommittedContributedActionInvoker } from './createCommittedContributedActionDeps';
import { createClientActionMachineRpcExecutor } from './clientActionMachineRpc';

// Credential files are outside the owning process. Client dispatch never
// activates a daemon entrypoint or prepares a packaged plugin artifact.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(),
  readStoredCredentials: async () => null,
}));

describe('committed client Message Action delivery', () => {
  it('delivers the Tasks launcher and committed reference from canonical CLI invocation to its strict reverse consumer', async () => {
    const pluginId = PLUGIN_MANIFEST.id;
    const action = { pluginId, localId: 'tasks/open-create-v1' };
    const messageActionReference = { v: 1 as const, sessionId: 'committed-session', messageId: 'committed-message', observedRevision: 'revision-1' };
    const bundled = loadCurrentBundledPluginLocatorResult();
    const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult: {
      loadedPlugins: bundled.loadedPlugins.filter(plugin => plugin.pluginId === pluginId)
        .map(plugin => ({ ...plugin, manifest: normalizePluginManifestV2(PLUGIN_MANIFEST) })), diagnosticsByPluginId: {},
    }, provenance: 'first_party' }));
    const executeClientAction = createClientActionMachineRpcExecutor(() => ({
      // A reconnect advertisement is incomplete; the live answering route still exists.
      hasConnectedClientRpcHandler: () => false,
      // Substitute only the Machine-to-UI network hop. The real producer's
      // serialized DTO must pass the answering client's exact closed schema.
      callConnectedClientRpc: async (_method, raw, options) => {
        const request = UiContributedActionExecuteRequestV1Schema.parse(JSON.parse(JSON.stringify(raw)));
        expect(request).toMatchObject({ action, input: {}, messageActionReference, surface: 'cli' });
        options.onIssued();
        return { ok: true, result: { ok: true, result: { delivered: request.messageActionReference ?? null } } };
      },
    }));
    const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { contributes, pluginIds: [pluginId], executeClientAction } });
    try {
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), invokeContributedAction: createCommittedContributedActionInvoker({
        acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry(),
      }) });
      expect(await executor.execute('action.invoke', { action, input: {}, messageActionReference }, { surface: 'cli' }))
        .toEqual({ ok: true, result: { delivered: messageActionReference } });
      // An unsupported target cannot silently discard the new reference and
      // report a successful invocation with no Message context.
      expect(await executor.execute('action.invoke', { action: { pluginId, localId: 'tasks/list-v1' },
        input: {}, messageActionReference }, { surface: 'cli' }))
        .toMatchObject({ ok: false, errorCode: 'plugin_message_action_unavailable' });
    } finally { await fixture.dispose(); }
  });
});
