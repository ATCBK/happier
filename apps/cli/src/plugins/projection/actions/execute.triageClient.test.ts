import { describe, expect, it } from 'vitest';
import { createActionExecutor, PluginActionContributionV2Schema, UiContributedActionExecuteRequestV1Schema } from '@happier-dev/protocol';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createCommittedContributedActionInvoker } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createClientActionMachineRpcExecutor } from '@/plugins/runtime/invocation/actions/clientActionMachineRpc';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/triage/src/manifest.js';
import { TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1, TriageRunConfiguredActionInputV1Schema } from '../../../../../../packages/plugins/triage/src/actions/configuredActionRunProtocol.js';

describe('Triage configured-run client placement', () => {
  // An isolated authored owner exercises the actual Action declaration without
  // installing a second copy of the already bundled first-party plugin.
  const fixturePluginId = 'example.triage-relay';
  it.each(['agent', 'mcp'] as const)('admits the actual configured-run declaration and delivers the real %s surface to the answering client', async (surface) => {
    const declared = PLUGIN_MANIFEST.contributes.actions?.find(action => action.id === TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1);
    if (!declared) throw new Error('Configured-run declaration missing');
    const action = PluginActionContributionV2Schema.parse(declared);
    const input = TriageRunConfiguredActionInputV1Schema.parse({ v: 1, actionId: 'ask', destination: 'single', entries: [{
      entryRef: { source: { pluginId: 'example.source', localId: 'issues' }, kindId: 'issue', collisionScope: 'repository', entryId: '42' },
      sourceInstanceId: '11111111-1111-4111-8111-111111111111',
    }] });
    const requests: unknown[] = [];
    const result = { v: 1, status: 'cancelled' } as const;
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
      plugins: [{ manifest: createPluginManifestV2Fixture({ id: fixturePluginId, contributes: { actions: [action] } }),
        files: { 'daemon.mjs': 'export function activate() {}' } }],
      runtimeOptions: { executeClientAction: createClientActionMachineRpcExecutor(() => ({
        hasConnectedClientRpcHandler: () => true,
        // Only the connected-client RPC is substituted. Public meta Action,
        // actual declaration, admission, committed runtime and relay remain real.
        callConnectedClientRpc: async (_method, payload, options) => {
          requests.push(UiContributedActionExecuteRequestV1Schema.parse(payload));
          options.onIssued();
          return { ok: true, result: { ok: true, result } };
        },
      })) },
    });
    try {
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
        invokeContributedAction: createCommittedContributedActionInvoker({
          acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry(),
        }),
      });
      const request = { action: { pluginId: fixturePluginId, localId: action.id }, input };
      // Client placement delegates present-user approval to the answering
      // client's canonical dispatcher; it must not ask independently here.
      expect(await executor.execute('action.invoke', request, { surface })).toEqual({ ok: true, result });
      expect(requests).toEqual([{ v: 1, ...request, surface,
        expectedContributorOccurrenceId: fixture.registry.readPluginOccurrenceId?.(fixturePluginId) }]);
    } finally { await fixture.dispose(); }
  });
});
