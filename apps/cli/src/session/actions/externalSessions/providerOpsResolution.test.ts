import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PluginAgentContributionV2,
  PluginSourceCustodyV1,
} from '@happier-dev/protocol';

import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';
import type { ResolvedAgentContribution } from '@/plugins/projection/registry/types';
import { createManifestAgentCatalogEntry } from '@/plugins/projection/registry/agentCliMetadata';

const {
  resolveExecutionSurfacesMock,
  activateAgentRuntimeContributionOnDemandMock,
  acquireAuthoritativePluginRuntimeRegistryLeaseMock,
} = vi.hoisted(() => ({
  resolveExecutionSurfacesMock: vi.fn(),
  activateAgentRuntimeContributionOnDemandMock: vi.fn(
    async (_registry: unknown, _agentId: unknown) => {},
  ),
  acquireAuthoritativePluginRuntimeRegistryLeaseMock: vi.fn(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    resolveExecutionSurfaces: (...args: unknown[]) => resolveExecutionSurfacesMock(...args),
  }),
}));

vi.mock('@/agent/runtime/registry/activationDemand', () => ({
  activateAgentRuntimeContributionOnDemand:
    (registry: unknown, agentId: unknown) =>
      activateAgentRuntimeContributionOnDemandMock(registry, agentId),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease:
    () => acquireAuthoritativePluginRuntimeRegistryLeaseMock(),
}));

describe('resolveExternalSessionSurfaceOps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('demands the exact Agent and resolves ordinary operations from the held current lease', async () => {
    const retirement = new AbortController();
    const runtimeLease = {
      occurrenceId: 'plugin-occurrence-1',
      retirementSignal: retirement.signal,
      isCurrent: () => true,
      externalSessions: {},
    };
    const registry = {
      agentRuntimesByAgentId: new Map([['opencode', runtimeLease]]),
    };
    const release = vi.fn(async () => {});
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({ registry, release });
    const fallbackOps: ExternalSessionExecutionSurface = {};
    resolveExecutionSurfacesMock.mockResolvedValue({
      externalSession: fallbackOps,
    });

    const { resolveExternalSessionSurfaceOps } = await import('./providerOpsResolution');
    const resolved = await resolveExternalSessionSurfaceOps('opencode');
    expect(resolved).not.toBe(fallbackOps);
    expect(resolved.externalLinkedTakeoverWriterSafety).toBe('unsupported');
    expect(activateAgentRuntimeContributionOnDemandMock).toHaveBeenCalledWith(
      registry,
      'opencode',
    );
    expect(resolveExecutionSurfacesMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('projects an auxiliary-only Agent source and operations without requiring a primary runtime catalog entry', async () => {
    const definition = {
      id: 'opencode',
      title: 'OpenCode G',
      capabilities: { surfaces: ['externalSessions'] },
      surfaces: {
        externalSession: {
          sources: [{
            sourceKind: 'opencodeServer',
            schema: {
              fields: [{ name: 'kind', kind: 'literal', value: 'opencodeServer' }],
            },
            key: {
              segments: [{ kind: 'literal', value: 'opencodeServer:g' }],
            },
          }],
        },
      },
    } satisfies PluginAgentContributionV2;
    const agent = {
      id: 'opencode',
      identity: { pluginId: 'acme.generation-g', localId: 'opencode' },
      provenance: 'external',
      source: { kind: 'path' },
      definition: { id: 'opencode', displayName: 'OpenCode G' },
      richDefinition: { provenance: 'external', definition },
      catalogEntry: createManifestAgentCatalogEntry({
        agentId: 'opencode', pluginId: 'acme.generation-g',
        definition, cli: null, provenance: 'external',
      }),
    } as unknown as ResolvedAgentContribution;
    const retirement = new AbortController();
    const runtimeLease = {
      occurrenceId: 'plugin-occurrence-g',
      sourceCustody: { kind: 'development', registeredRootId: 'projection-g' },
      retirementSignal: retirement.signal,
      isCurrent: () => true,
      externalSessions: {},
    };
    const release = vi.fn(async () => {});
    const registry = {
      contributes: {
        agents: [agent],
        agentDefinitionsById: new Map([['opencode', agent]]),
      },
      agentRuntimesByAgentId: new Map([['opencode', runtimeLease]]),
    };
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValueOnce({
      registry,
      release,
    });

    const { resolveExternalSessionSourceSurface } =
      await import('./providerOpsResolution');
    const resolved = await resolveExternalSessionSourceSurface(
      'opencode',
      { kind: 'opencodeServer' },
    );

    expect(resolved).toMatchObject({
      ok: true,
      source: { kind: 'opencodeServer' },
      currentAgent: {
        identity: { pluginId: 'acme.generation-g', localId: 'opencode' },
      },
      sourceKeyOwner: { sourceKey: 'opencodeServer%3Ag' },
    });
    expect(acquireAuthoritativePluginRuntimeRegistryLeaseMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(['absent', 'stale', 'retired'] as const)(
    'fails closed when the held lease contribution is %s even if bridge re-resolution could succeed',
    async (state) => {
      const retirement = new AbortController();
      if (state === 'retired') retirement.abort();
      const runtimeLease = {
        occurrenceId: 'plugin-occurrence-1',
        retirementSignal: retirement.signal,
        isCurrent: () => state !== 'stale',
        ...(state === 'absent' ? {} : { externalSessions: {} }),
      };
      const release = vi.fn(async () => {});
      const registry = {
        agentRuntimesByAgentId: new Map([['opencode', runtimeLease]]),
      };
      acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
        registry,
        release,
      });
      resolveExecutionSurfacesMock.mockResolvedValue({
        externalSession: {} satisfies ExternalSessionExecutionSurface,
      });

      const { resolveExternalSessionSurfaceOps } = await import('./providerOpsResolution');
      const rejection = await resolveExternalSessionSurfaceOps('opencode')
        .then(() => null, (error: unknown) => error);
      expect(rejection).toMatchObject({
        name: 'ExternalSessionFollowFailureError',
        kind: 'agent_unavailable',
        message: expect.stringMatching(/missing current external-session Agent operations/i),
      });
      expect(resolveExecutionSurfacesMock).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it('fails closed for follow when the held lease has no contribution instead of mixing generations', async () => {
    const retirement = new AbortController();
    const release = vi.fn(async () => {});
    const runtimeLease = {
      occurrenceId: 'plugin-occurrence-1',
      retirementSignal: retirement.signal,
      isCurrent: () => true,
    };
    const registry = {
      contributes: {
        agentDefinitionsById: new Map([['opencode', {
          identity: { pluginId: 'acme.opencode', localId: 'opencode' },
        }]]),
      },
      readPluginOccurrenceId: () => 'plugin-occurrence-1',
      readPluginSourceCustody: () => ({
        kind: 'development', registeredRootId: 'follow-fixture',
      }),
      agentRuntimesByAgentId: new Map([['opencode', runtimeLease]]),
    };
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
      registry,
      release,
    });
    resolveExecutionSurfacesMock.mockResolvedValue({
      externalSession: {} satisfies ExternalSessionExecutionSurface,
    });

    const { resolveOccurrenceBoundExternalSessionFollowSurface } =
      await import('./providerOpsResolution');
    await expect(resolveOccurrenceBoundExternalSessionFollowSurface(
      'opencode',
      'link-generation-1',
    )).rejects.toThrow(/missing current external-session Agent operations/i);
    expect(resolveExecutionSurfacesMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('separates an absent follow generation from one retired while resolving', async () => {
    const release = vi.fn(async () => {});
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
      registry: { agentRuntimesByAgentId: new Map() },
      release,
    });

    const { resolveOccurrenceBoundExternalSessionFollowSurface } =
      await import('./providerOpsResolution');
    const absent = await resolveOccurrenceBoundExternalSessionFollowSurface(
      'opencode',
      'link-generation-1',
    ).then(() => null, (error: unknown) => error);
    expect(absent).toMatchObject({
      name: 'ExternalSessionFollowFailureError',
      kind: 'agent_unavailable',
      message: expect.stringMatching(/missing current external-session Agent occurrence/i),
    });

    const retirement = new AbortController();
    const isCurrent = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
      registry: {
        contributes: {
          agentDefinitionsById: new Map([['opencode', {
            identity: { pluginId: 'acme.opencode', localId: 'opencode' },
          }]]),
        },
        agentRuntimesByAgentId: new Map([['opencode', {
          pluginId: 'acme.opencode',
          occurrenceId: 'plugin-generation-1',
          retirementSignal: retirement.signal,
          isCurrent,
          externalSessions: {},
        }]]),
        readPluginOccurrenceId: () => 'occurrence-1',
        readPluginSourceCustody: () => ({
          kind: 'development',
          registeredRootId: 'source-root-1',
        }),
      },
      release,
    });
    const retired = await resolveOccurrenceBoundExternalSessionFollowSurface(
      'opencode',
      'link-generation-1',
    ).then(() => null, (error: unknown) => error);
    expect(retired).toMatchObject({
      name: 'ExternalSessionFollowFailureError',
      kind: 'source_changed',
      message: expect.stringMatching(/occurrence retired while resolving/i),
    });
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('binds follow operations and lifecycle coordinates to the same current lease', async () => {
    const retirement = new AbortController();
    const release = vi.fn(async () => {});
    const runtimeLease = {
      occurrenceId: 'plugin-occurrence-1',
      immutableGenerationId: 'immutable-plugin-generation-1',
      retirementSignal: retirement.signal,
      isCurrent: () => true,
      externalSessions: {},
    };
    const registry = {
      contributes: {
        agentDefinitionsById: new Map([['opencode', {
          identity: { pluginId: 'acme.opencode', localId: 'opencode' },
        }]]),
      },
      agentRuntimesByAgentId: new Map([['opencode', runtimeLease]]),
      readPluginOccurrenceId: () => 'occurrence-1',
      readPluginSourceCustody: () => ({
        kind: 'managed',
        immutableGenerationId: 'immutable-plugin-generation-1',
        installSource: 'localPath',
      }),
    };
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
      registry,
      release,
    });
    const fallbackOps: ExternalSessionExecutionSurface = {};
    resolveExecutionSurfacesMock.mockResolvedValue({ externalSession: fallbackOps });

    const { resolveOccurrenceBoundExternalSessionFollowSurface } =
      await import('./providerOpsResolution');
    const resolved = await resolveOccurrenceBoundExternalSessionFollowSurface(
      'opencode',
      'link-generation-1',
    );
    expect(resolved.providerOps).not.toBe(fallbackOps);
    expect(resolved.providerOps.externalLinkedTakeoverWriterSafety).toBe('unsupported');
    expect(resolved.resource).toEqual({
      linkGeneration: 'link-generation-1',
      occurrenceId: 'occurrence-1',
      retirementSignal: retirement.signal,
    });
    expect(resolved.occurrenceId).toBe('occurrence-1');
    expect(resolved.sourceCustody).toEqual({
      kind: 'managed',
      immutableGenerationId: 'immutable-plugin-generation-1',
      installSource: 'localPath',
    });
    expect(resolved).not.toHaveProperty('immutablePluginGenerationId');
    expect(activateAgentRuntimeContributionOnDemandMock).toHaveBeenCalledWith(
      registry,
      'opencode',
    );
    expect(resolveExecutionSurfacesMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'bundled first-party',
      custody: {
        kind: 'bundled_first_party',
        packagedRuntime: {
          kind: 'cli_version_root',
          versionRootId: 'cli-version-root-1',
        },
      } satisfies PluginSourceCustodyV1,
    },
    {
      label: 'development',
      custody: {
        kind: 'development',
        registeredRootId: 'development-root-1',
      } satisfies PluginSourceCustodyV1,
    },
  ])('resolves a current $label follow occurrence without an immutable generation', async ({ custody }) => {
    const retirement = new AbortController();
    const release = vi.fn(async () => {});
    const runtimeLease = {
      occurrenceId: 'runtime-occurrence-1',
      retirementSignal: retirement.signal,
      isCurrent: () => true,
      externalSessions: {},
      sourceCustody: custody,
    };
    const registry = {
      contributes: {
        agentDefinitionsById: new Map([['opencode', {
          identity: { pluginId: 'acme.opencode', localId: 'opencode' },
        }]]),
      },
      agentRuntimesByAgentId: new Map([['opencode', runtimeLease]]),
      readPluginOccurrenceId: () => 'occurrence-1',
      readPluginSourceCustody: () => custody,
    };
    acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
      registry,
      release,
    });

    const { resolveOccurrenceBoundExternalSessionFollowSurface } =
      await import('./providerOpsResolution');
    const resolved = await resolveOccurrenceBoundExternalSessionFollowSurface(
      'opencode',
      'link-generation-1',
    );

    expect(resolved.occurrenceId).toBe('occurrence-1');
    expect(resolved.sourceCustody).toEqual(custody);
    expect(resolved).not.toHaveProperty('immutablePluginGenerationId');
    expect(release).toHaveBeenCalledTimes(1);
  });

});
