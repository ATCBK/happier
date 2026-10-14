import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

const daemonRpc = vi.hoisted(() => vi.fn<(request: Readonly<{
  machineId: string; serverId?: string | null; method: string; payload: unknown;
}>) => Promise<unknown>>());
// The daemon network port is the system boundary. Capability codecs and projection admission remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: daemonRpc }));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
let serverId = '';
let projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {}, familiesById: {} });
let capabilityResult: unknown;

beforeEach(async () => {
  await homes.reset();
  clearDaemonMergedProjectionCacheForTests();
  serverId = await homes.addHome({ name: 'Agent inventory', serverUrl: 'https://agent-inventory.test', accountId: 'inventory-account' });
  const profile = AccountProfileSchema.parse({ id: 'inventory-account',
      connectedAccountsV4: [{
        ref: {
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          accountId: 'acct-work',
        },
        status: 'connected',
        kind: 'oauth',
        authenticationModeId: 'oauth',
        configurationReady: true,
        configurationRevision: null,
        revisionSemantics: 'revisioned',
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        scopes: [],
      }],
      connectedAccountGroupsV4: [],
  });
  storage.getState().activateProfileScope({ serverId, accountId: profile.id });
  storage.getState().applyProfile(profile);
  homes.answer(serverId, '/v1/account/profile', { body: profile });
  homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
  homes.answer(serverId, CONNECTED_PRESENTATION_ROWS_ROUTE_V1, { body: { status: 'present', revision: 1,
    content: { t: 'plain', v: { v: 1, entries: [{ v: 1, subject: { kind: 'account', account: profile.connectedAccountsV4[0]!.ref }, label: 'Work account' }] } } } });
  homes.answer(serverId, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1, { body: { status: 'present', revision: 1,
    content: { t: 'plain', v: { v: 1, entries: [] } } } });
  projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {}, familiesById: {} });
  capabilityResult = { ok: false, error: { code: 'UNSUPPORTED', message: 'No probe installed' } };
  daemonRpc.mockReset();
  daemonRpc.mockImplementation(async request => {
    expect(request).toMatchObject({ machineId: 'machine-1', serverId });
    if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
      return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection });
    }
    if (request.method === RPC_METHODS.CAPABILITIES_INVOKE) return capabilityResult;
    throw new Error(`Unexpected Machine RPC: ${request.method}`);
  });
});

afterEach(async () => { await homes.reset(); clearDaemonMergedProjectionCacheForTests(); });

describe('defaultActionExecutor canonical agent inventory corridor', () => {
  it('answers sessions.spawn.connected_services.list for a novel external qualified Agent instead of unsupported_action', async () => {
    projection = PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        agentsById: {
          'acme-voice-agent': {
            id: 'acme-voice-agent',
            identity: { pluginId: 'acme.voice', localId: 'agent' },
            title: 'Acme Voice Agent',
            connectedAccounts: [{
              purpose: 'models',
              service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
              credentialKinds: ['oauth'],
            }],
          },
        },
        familiesById: {},
    });
    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'sessions.spawn.connected_services.list',
      { agentId: 'acme-voice-agent', backendTargetKey: 'agent:acme.voice/agent', machineId: 'machine-1' },
      { surface: 'voice', serverId },
    );

    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.result).toMatchObject({ agentId: 'acme-voice-agent', supportedServiceIds: ['happier.agent.codex/openai-codex'], items: [
      expect.objectContaining({
        value: 'happier.agent.codex/openai-codex:profile:acct-work',
        label: 'Work account',
      }),
    ] });
    expect(daemonRpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1', serverId,
      method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE }));
  });

  it('answers agents.session_modes.list by probing the selected machine instead of unsupported_action', async () => {
    capabilityResult = {
        ok: true,
        result: {
          agentId: 'acme-voice-agent',
          availableModes: [
            { id: 'build', name: 'Build', description: 'Full access' },
            { id: 'plan', name: 'Plan' },
          ],
          source: 'dynamic',
        },
    };
    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'agents.session_modes.list',
      { agentId: 'acme-voice-agent', backendTargetKey: 'agent:acme.voice/agent', machineId: 'machine-1' },
      { surface: 'voice', serverId },
    );

    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.result).toEqual({
      agentId: 'acme-voice-agent',
      items: [
        { id: 'build', label: 'Build', description: 'Full access' },
        { id: 'plan', label: 'Plan' },
      ],
      source: 'dynamic',
    });
    expect(daemonRpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1', serverId,
      method: RPC_METHODS.CAPABILITIES_INVOKE, payload: expect.objectContaining({ method: 'probeModes' }) }));
  });

  it('answers agents.config_options.list by probing the selected machine instead of unsupported_action', async () => {
    capabilityResult = {
        ok: true,
        result: {
          agentId: 'acme-voice-agent',
          configOptions: [
            {
              id: 'reasoning-effort',
              name: 'Reasoning effort',
              type: 'select',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High', description: 'Slower' },
              ],
            },
          ],
          source: 'dynamic',
        },
    };
    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'agents.config_options.list',
      { agentId: 'acme-voice-agent', backendTargetKey: 'agent:acme.voice/agent', machineId: 'machine-1' },
      { surface: 'voice', serverId },
    );

    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.result).toEqual({
      agentId: 'acme-voice-agent',
      items: [
        {
          id: 'reasoning-effort',
          label: 'Reasoning effort',
          type: 'select',
          options: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High', description: 'Slower' },
          ],
        },
      ],
      source: 'dynamic',
    });
    expect(daemonRpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1', serverId,
      method: RPC_METHODS.CAPABILITIES_INVOKE, payload: expect.objectContaining({ method: 'probeConfigOptions' }) }));
  });

  it('resolves the connected-services options source through the same canonical action options owner', async () => {
    projection = PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        agentsById: {
          'acme-runtime-agent': {
            id: 'acme-runtime-agent',
            identity: { pluginId: 'acme.voice', localId: 'agent' },
            connectedAccounts: [{
              purpose: 'models',
              service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
              credentialKinds: ['oauth'],
            }],
          },
        },
        familiesById: {},
    });
    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'action.options.resolve',
      {
        actionId: 'session.spawn_new',
        fieldPath: 'connectedServices',
        optionsSourceId: 'sessions.spawn.connected_services.available',
        executionTarget: { serverId, machineId: 'machine-1' },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'acme.voice', localId: 'agent' },
        },
      },
      { surface: 'voice', serverId },
    );

    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.result).toMatchObject({
      options: [expect.objectContaining({ value: 'happier.agent.codex/openai-codex:profile:acct-work' })],
    });
    expect(daemonRpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1', serverId,
      method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE }));
  });
});
