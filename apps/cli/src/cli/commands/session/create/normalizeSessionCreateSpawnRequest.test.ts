import { describe, expect, it, vi } from 'vitest';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

import {
  normalizeSessionCreateSpawnRequest,
  type SessionCreateSpawnRequestNormalizerDeps,
} from './normalizeSessionCreateSpawnRequest';

function createDeps(
  overrides: Partial<SessionCreateSpawnRequestNormalizerDeps> = {},
): SessionCreateSpawnRequestNormalizerDeps {
  return {
    activeServerId: 'server-1',
    defaultAgentId: 'claude',
    readSettings: async () => ({
      machineIdByServerIdByAccountId: {
        'server-1': { 'account-1': 'machine-account-current' },
      },
      lastTokenSubByServerId: { 'server-1': 'account-1' },
    }),
    readAgentDefinitions: () => [
      {
        id: 'claude',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
      },
      {
        id: 'review-bot',
        identity: { pluginId: 'com.acme.review', localId: 'review-bot' },
      },
    ],
    now: () => 100,
    ...overrides,
  };
}

describe('normalizeSessionCreateSpawnRequest', () => {
  it.each([
    'agent:happier.agent.custom-acp/custom-acp:definition:chosen',
    'backend:chosen:configured:chosen',
  ])('preserves the configured definition through ordinary Session spawn admission: %s', async (backendTargetKey) => {
    const normalized = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project', backendTargetKey, modelId: 'chosen-model',
    }, createDeps({ readAgentDefinitions: () => readAgentCatalogSnapshot().agentDefinitionsById.values() }));
    expect(normalized.agentId).toBe('custom-acp');
    expect(normalized.input.agentTarget).toEqual({
      kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'chosen',
    });
    expect(normalized.input.modelSelection?.ref).toMatchObject({
      agentTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:chosen', modelId: 'chosen-model',
    });
  });

  it('resolves a qualified bundled target through its declared identity rather than its routing-id spelling', async () => {
    const normalized = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project', backendTargetKey: 'agent:happier.agent.claude/claude',
    }, createDeps({ readAgentDefinitions: () => readAgentCatalogSnapshot().agentDefinitionsById.values() }));
    expect(normalized.agentId).toBe('claude');
    expect(normalized.input.agentTarget).toEqual({
      kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
    });
  });
  it('normalizes permission aliases and rejects unknown modes before Action dispatch', async () => {
    const normalized = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      permissionMode: 'read_only',
    }, createDeps());

    expect(normalized.input.permissionMode).toBe('read-only');
    await expect(normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      permissionMode: 'surprise-me',
    }, createDeps())).rejects.toThrow(/permission mode/i);
  });

  it('keeps a Provider-bound literal model named default while native default still resets', async () => {
    const providerBound = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      modelId: 'default',
      providerConnectionId: 'provider-1',
    }, createDeps());

    expect(providerBound.input.modelSelection).toMatchObject({
      v: 1,
      ref: {
        agentTargetKey: 'agent:happier.agent.claude/claude',
        providerConnectionId: 'provider-1',
        modelId: 'default',
      },
    });

    const nativeDefault = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      modelId: 'default',
    }, createDeps());

    expect(nativeDefault.input.modelSelection).toBeUndefined();
  });

  it('emits one strict V2 request with the exact target and contributed external Agent identity', async () => {
    const normalized = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: 'backend:review-bot',
      modelId: 'review-model',
      providerConnectionId: 'provider-1',
      permissionMode: 'safe-yolo',
      agentModeId: 'plan',
      configOptions: { reasoning_effort: 'high' },
      title: 'Review',
      initialInput: { text: 'Please review this branch.' },
    }, createDeps());

    expect(normalized).toEqual({
      agentId: 'review-bot',
      input: {
        executionTarget: { serverId: 'server-1', machineId: 'machine-account-current' },
        directory: { kind: 'path', path: '/repo/project' },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'com.acme.review', localId: 'review-bot' },
        },
        modelSelection: {
          v: 1,
          updatedAt: 100,
          ref: {
            agentTargetKey: 'agent:com.acme.review/review-bot',
            providerConnectionId: 'provider-1',
            modelId: 'review-model',
          },
        },
        permissionMode: 'safe-yolo',
        agentModeId: 'plan',
        configuration: {
          mode: { value: null, updatedAtMs: 100 },
          model: { value: null, updatedAtMs: 100 },
          permissionIntent: { value: null, updatedAtMs: 100 },
          options: {
            reasoning_effort: { value: 'high', updatedAtMs: 100 },
          },
        },
        title: 'Review',
        initialInput: { text: 'Please review this branch.' },
      },
    });
  });

  it('resolves a qualified external Agent key through the catalog before legacy conversion', async () => {
    const normalized = await normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: 'agent:com.acme.review/review-bot',
      modelId: 'review-model',
    }, createDeps({
      readAgentDefinitions: () => [
        {
          id: 'com.acme.review/review-bot',
          identity: { pluginId: 'com.acme.review', localId: 'review-bot' },
        },
      ],
    }));

    expect(normalized.agentId).toBe('com.acme.review/review-bot');
    expect(normalized.input.agentTarget).toEqual({
      kind: 'agent',
      identity: { pluginId: 'com.acme.review', localId: 'review-bot' },
    });
    expect(normalized.input.modelSelection?.ref).toMatchObject({
      agentTargetKey: 'agent:com.acme.review/review-bot',
      modelId: 'review-model',
    });
  });

  it('still rejects a qualified Agent key that no catalog Agent owns', async () => {
    await expect(normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: 'agent:missing.acme.review/review-bot',
    }, createDeps())).rejects.toThrow(/--backend does not identify an executable Agent/);
  });

  it('normalizes explicit environment variables into the strict V2 Action input', async () => {
    await expect(normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      environmentVariables: { TOKEN: 'secret', camelCase: 'daemon-compatible' },
    }, createDeps())).resolves.toMatchObject({
      input: {
        environmentVariables: { TOKEN: 'secret', camelCase: 'daemon-compatible' },
      },
    });
  });

  it('rejects conflicting configuration aliases before Action dispatch', async () => {
    await expect(normalizeSessionCreateSpawnRequest({
      directory: '/repo/project',
      backendTargetKey: null,
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 10,
        overrides: {
          reasoning_effort: { updatedAt: 10, value: 'low' },
        },
      },
      configOptions: { reasoning_effort: 'high' },
    }, createDeps())).rejects.toThrow(/conflicts/);
  });
});
