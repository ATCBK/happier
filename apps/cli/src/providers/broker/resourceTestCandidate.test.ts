import { describe, expect, it, vi } from 'vitest';
import { TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import {
  DaemonProviderModelProjectionResponseV1Schema,
  type DaemonProviderModelProjectionRequestV1,
  type DaemonProviderModelProjectionResponseV1,
} from '@happier-dev/protocol/rpc';

import {
  projectTeamCredentialSourceModelFilter,
  resolveTeamCredentialBrokerEligibility,
  resolveTeamCredentialResourceCatalogApplications,
  resolveTeamCredentialResourceTestCandidate,
  resolveTeamCredentialSourceModelCatalog,
} from './resourceTestCandidate';

const parsedSource = TeamCredentialSourceBindingV1Schema.parse({
  v: 1 as const,
  kind: 'provider_connection' as const,
  connectionId: 'connection-1',
  connectionSecurityFingerprint: 'connection-security:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  credentialSlotId: 'slot-1',
});
if (parsedSource.kind !== 'provider_connection') throw new Error('expected Provider source');
const source = parsedSource;

describe('projectTeamCredentialSourceModelFilter', () => {
  it('maps every exact source kind without inferring an application', () => {
    const accountTarget = {
      kind: 'account' as const,
      account: {
        service: { pluginId: 'happier.connected-account.example', localId: 'example' },
        accountId: 'account-1',
      },
    };
    const poolTarget = {
      kind: 'group' as const,
      service: { pluginId: 'happier.connected-account.example', localId: 'example' },
      groupId: 'pool-1',
    };
    expect(projectTeamCredentialSourceModelFilter(source)).toEqual({
      providerConnection: {
        connectionId: source.connectionId,
        expectedConnectionSecurityFingerprint: source.connectionSecurityFingerprint,
      },
    });
    expect(projectTeamCredentialSourceModelFilter({
      v: 1, kind: 'connected_account', target: accountTarget, credentialIncarnation: 'incarnation-1',
    })).toEqual({ connectedAccountTarget: accountTarget });
    expect(projectTeamCredentialSourceModelFilter({
      v: 1, kind: 'connected_pool', target: poolTarget, poolIncarnation: 'incarnation-1',
    })).toEqual({ connectedAccountTarget: poolTarget });
  });
});

function projection(
  agentTargetKey: string,
  modelId: string,
  protocol: 'openai-responses' | 'openai-chat' | 'anthropic' | 'unsupported' = 'openai-responses',
): Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }> {
  const parsed = DaemonProviderModelProjectionResponseV1Schema.parse({
    status: 'success' as const,
    agentTargetKey,
    groups: [{
      connectionId: 'connection-1',
      providerName: 'Provider', connectionName: 'Connection', connectionRole: 'default' as const,
      connectionDisplayNameMode: 'automatic' as const, connectionRevision: 1,
      sourceRevision: 'source-revision', modelLoadAction: 'available' as const,
      authorization: { authorized: true as const }, manualModelPolicy: 'catalog-only' as const,
      supportsFreeformModelIds: false, suppressedConnectedServiceIds: [],
      rows: [{
        ref: { agentTargetKey, providerConnectionId: 'connection-1', modelId },
        descriptor: { id: modelId, name: modelId },
        application: {
          agentTargetKey,
          implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
          endpointTemplateId: protocol === 'openai-responses'
            ? 'cliproxyapi-openai-responses'
            : protocol === 'openai-chat'
              ? 'cliproxyapi-openai-chat'
              : protocol === 'anthropic'
                ? 'cliproxyapi-anthropic'
                : 'unsupported',
          protocol,
        },
        sources: { manual: false, static: true, probe: false }, confidence: 'verified_static' as const,
        compatibility: {
          result: {
            status: 'verified' as const,
            selectedProtocol: protocol,
            evidence: { sourceUrls: ['https://docs.example.test'], verifiedAt: '2026-07-11' },
          },
          compatibilityFingerprint: 'compatibility:v1:fixture', confirmed: false,
        },
        endpointHealth: 'available' as const,
        catalog: { stale: false }, loadState: 'unknown' as const, visibility: 'visible' as const,
      }],
    }],
  });
  if (parsed.status !== 'success') throw new Error('expected a success projection');
  return parsed;
}

describe('resolveTeamCredentialResourceTestCandidate', () => {
  it('chooses one stable current canonical candidate through a strict brokered catalog selection', async () => {
    const projectModels = vi.fn(async ({ agentTargetKey }: { agentTargetKey: string }) => (
      agentTargetKey.endsWith('/z') ? projection(agentTargetKey, 'model-z') : projection(agentTargetKey, 'model-a')
    ));
    const result = await resolveTeamCredentialResourceTestCandidate({
      machineId: 'machine-1', teamId: 'team-1', resourceId: 'resource-1', source,
      expectedResourceRevision: 3,
      agentTargetKeys: ['agent:acme.example/z', 'agent:acme.example/a'], projectModels,
      createRequestId: () => 'request-1',
    });

    expect(result).not.toBeNull();
    expect(result?.application.agentTargetKey).toBe('agent:acme.example/a');
    expect(result?.request).toMatchObject({
      requestId: 'request-1', teamId: 'team-1', resourceId: 'resource-1',
      route: 'responses', pathAndQuery: '/v1/responses',
    });
    expect(JSON.parse(Buffer.from(result!.request.bodyBase64, 'base64').toString('utf8')))
      .toMatchObject({ model: 'model-a', max_output_tokens: 16 });
    expect(projectModels).toHaveBeenCalledWith(expect.objectContaining({
      providerConnection: {
        connectionId: source.connectionId,
        expectedConnectionSecurityFingerprint: source.connectionSecurityFingerprint,
      },
    }));
    expect(projectModels).toHaveBeenCalledTimes(1);
  });

  it('fails closed when every projected row is stale or unavailable', async () => {
    const current = projection('agent:acme.example/a', 'model-a');
    const stale = {
      ...current,
      groups: current.groups.map((group) => ({
        ...group,
        rows: group.rows.map((row) => ({ ...row, catalog: { stale: true } })),
      })),
    };
    await expect(resolveTeamCredentialResourceTestCandidate({
      machineId: 'machine-1', teamId: 'team-1', resourceId: 'resource-1', source,
      expectedResourceRevision: 3,
      agentTargetKeys: ['agent:acme.example/a'], projectModels: async () => stale,
      createRequestId: () => 'unused',
    })).rejects.toMatchObject({ status: 'unavailable', reason: 'projection_unavailable' });
    await expect(resolveTeamCredentialResourceTestCandidate({
      machineId: 'machine-1', teamId: 'team-1', resourceId: 'resource-1', source,
      expectedResourceRevision: 3,
      agentTargetKeys: ['agent:acme.example/a', 'agent:acme.example/z'],
      projectModels: async ({ agentTargetKey }) => agentTargetKey.endsWith('/a')
        ? stale : projection(agentTargetKey, 'model-a'),
      createRequestId: () => 'request-1',
    })).resolves.toMatchObject({ application: { agentTargetKey: 'agent:acme.example/z' } });
    const interrupted = new Error('source read interrupted');
    await expect(resolveTeamCredentialResourceTestCandidate({
      machineId: 'machine-1', teamId: 'team-1', resourceId: 'resource-1', source,
      expectedResourceRevision: 3, agentTargetKeys: ['agent:acme.example/a', 'agent:acme.example/z'],
      projectModels: async () => { throw interrupted; }, createRequestId: () => 'unused',
    })).rejects.toBe(interrupted);
  });

  it('discovers a Connected Account application from its exact target without caller application input', async () => {
    const target = {
      kind: 'account' as const,
      account: {
        service: { pluginId: 'happier.connected-account.example', localId: 'example' },
        accountId: 'account-1',
      },
    };
    const projectModels = vi.fn(
      async (_request: DaemonProviderModelProjectionRequestV1) => projection('agent:acme.example/a', 'model-a'),
    );

    await expect(resolveTeamCredentialResourceTestCandidate({
      machineId: 'machine-1', teamId: 'team-1', resourceId: 'resource-1',
      expectedResourceRevision: 3,
      source: { v: 1, kind: 'connected_account', target, credentialIncarnation: 'incarnation-1' },
      agentTargetKeys: ['agent:acme.example/a'], projectModels,
      createRequestId: () => 'request-1',
    })).resolves.toMatchObject({ application: { agentTargetKey: 'agent:acme.example/a' } });
    expect(projectModels).toHaveBeenCalledWith(expect.objectContaining({
      connectedAccountTarget: target,
    }));
    expect(projectModels.mock.calls[0]?.[0]).not.toHaveProperty('application');
  });

  it('builds the required Anthropic messages headers and body for an Anthropic candidate', async () => {
    const result = await resolveTeamCredentialResourceTestCandidate({
      machineId: 'machine-1', teamId: 'team-1', resourceId: 'resource-1', source,
      expectedResourceRevision: 3,
      agentTargetKeys: ['agent:acme.example/a'],
      projectModels: async () => projection('agent:acme.example/a', 'model-a', 'anthropic'),
      createRequestId: () => 'request-1',
    });

    expect(result?.request).toMatchObject({
      route: 'messages',
      pathAndQuery: '/v1/messages',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    });
    expect(JSON.parse(Buffer.from(result!.request.bodyBase64, 'base64').toString('utf8')))
      .toMatchObject({ model: 'model-a', max_tokens: 16 });
  });

  it('does not invent a request shape for an installed plugin protocol it does not understand', async () => {
    await expect(resolveTeamCredentialResourceTestCandidate({
      machineId: 'machine-1', teamId: 'team-1', resourceId: 'resource-1', source,
      expectedResourceRevision: 3,
      agentTargetKeys: ['agent:acme.example/a'],
      projectModels: async () => projection('agent:acme.example/a', 'model-a', 'unsupported'),
      createRequestId: () => 'unused',
    })).resolves.toBeNull();
  });

});

describe('resolveTeamCredentialBrokerEligibility', () => {
  const application = {
    agentTargetKey: 'agent:acme.example/a',
    implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
    endpointTemplateId: 'cliproxyapi-openai-responses',
    protocol: 'openai-responses' as const,
  };

  it('binds source eligibility to the exact application, model, and source revision', async () => {
    const projectModels = vi.fn(async () => projection(application.agentTargetKey, 'model-a'));
    const base = {
      machineId: 'machine-1',
      teamId: 'team-1',
      resourceId: 'resource-1',
      expectedResourceRevision: 3,
      source,
      application,
      modelId: 'model-a',
      sourceRevision: 'source-revision',
      projectModels,
    };

    await expect(resolveTeamCredentialBrokerEligibility(base)).resolves.toEqual({ status: 'eligible' });
    await expect(resolveTeamCredentialBrokerEligibility({
      ...base,
      application: { ...application, endpointTemplateId: 'other-endpoint' },
    })).resolves.toEqual({ status: 'unavailable', reason: 'application_unavailable' });
    await expect(resolveTeamCredentialBrokerEligibility({ ...base, modelId: 'other-model' }))
      .resolves.toEqual({ status: 'unavailable', reason: 'model_unavailable' });
    await expect(resolveTeamCredentialBrokerEligibility({ ...base, sourceRevision: 'older-source' }))
      .resolves.toEqual({ status: 'unavailable', reason: 'source_changed' });

    expect(projectModels).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      agentTargetKey: application.agentTargetKey,
      providerConnection: {
        connectionId: source.connectionId,
        expectedConnectionSecurityFingerprint: source.connectionSecurityFingerprint,
      },
      mode: 'picker',
    }));
  });

  it('fails closed without exposing projection details when the source owner is unavailable', async () => {
    const projectModels = vi.fn(async () => { throw new Error('opaque source unavailable'); });
    await expect(resolveTeamCredentialBrokerEligibility({
      machineId: 'machine-1',
      teamId: 'team-1',
      resourceId: 'resource-1',
      expectedResourceRevision: 3,
      source,
      application,
      modelId: 'model-a',
      sourceRevision: 'source-revision',
      projectModels,
    })).resolves.toEqual({ status: 'unavailable', reason: 'source_unavailable' });
    await expect(resolveTeamCredentialBrokerEligibility({
      machineId: 'machine-1', teamId: 'team-1', resourceId: 'resource-1', expectedResourceRevision: 3,
      source, application, modelId: 'model-a', sourceRevision: 'source-revision',
      projectModels: async () => ({
        status: 'error',
        error: { v: 1, code: 'provider_endpoint_unavailable', retryable: true, action: 'retry' },
      }),
    })).resolves.toEqual({ status: 'unavailable', reason: 'source_unavailable' });
  });

  it('answers source-only Pool eligibility without returning application or request material', async () => {
    const projectModels = vi.fn(async ({ agentTargetKey }: { agentTargetKey: string }) => (
      agentTargetKey.endsWith('/eligible')
        ? projection(agentTargetKey, 'model-a')
        : { ...projection(agentTargetKey, 'model-a'), groups: [] }
    ));

    const result = await resolveTeamCredentialBrokerEligibility({
      machineId: 'machine-1',
      teamId: 'team-1',
      resourceId: 'resource-1',
      expectedResourceRevision: 3,
      source,
      scope: 'source_any',
      agentTargetKeys: ['agent:acme.example/unavailable', 'agent:acme.example/eligible'],
      projectModels,
    });

    expect(result).toEqual({ status: 'eligible' });
    expect(result).not.toHaveProperty('application');
    expect(result).not.toHaveProperty('request');
    expect(projectModels).toHaveBeenCalledTimes(1);
  });

  it('preserves a typed source-row refusal in exact and source-only eligibility while keeping an observed empty catalog distinct', async () => {
    const current = projection(application.agentTargetKey, 'model-a');
    const denied: DaemonProviderModelProjectionResponseV1 = {
      ...current,
      groups: current.groups.map(group => ({
        ...group,
        authorization: { authorized: false as const, error: createProviderErrorV1('provider_not_enabled_on_machine') },
      })),
    };
    const base = {
      machineId: 'machine-1', teamId: 'team-1', resourceId: 'resource-1',
      expectedResourceRevision: 3, source,
    };
    const exact = { application, modelId: 'model-a', sourceRevision: 'source-revision' };
    const sourceOnly = { scope: 'source_any' as const, agentTargetKeys: [application.agentTargetKey] };
    for (const selection of [exact, sourceOnly]) {
      await expect(resolveTeamCredentialBrokerEligibility({
        ...base, ...selection, projectModels: async () => denied,
      })).resolves.toEqual({ status: 'unavailable', reason: 'source_unavailable' });
    }
    for (const [selection, reason] of [[exact, 'application_unavailable'], [sourceOnly, 'model_unavailable']] as const) {
      await expect(resolveTeamCredentialBrokerEligibility({
        ...base, ...selection, projectModels: async () => ({ ...current, groups: [] }),
      })).resolves.toEqual({ status: 'unavailable', reason });
    }
  });
});

describe('resolveTeamCredentialResourceCatalogApplications', () => {
  it('enumerates every exact current application without choosing a protocol default', async () => {
    const input = {
      machineId: 'machine-1', teamId: 'team-1', resourceId: 'resource-1', source,
      expectedResourceRevision: 3,
      agentTargetKeys: ['agent:acme.example/a-stale', 'agent:acme.example/responses', 'agent:acme.example/chat'],
      projectModels: async ({ agentTargetKey }) => {
        const current = projection(agentTargetKey, 'shared-model', agentTargetKey.endsWith('/chat') ? 'openai-chat' : 'openai-responses');
        return agentTargetKey.endsWith('/a-stale') ? {
          ...current,
          groups: current.groups.map(group => ({
            ...group, rows: group.rows.map(row => ({ ...row, catalog: { stale: true } })),
          })),
        } : current;
      },
    } satisfies Parameters<typeof resolveTeamCredentialResourceCatalogApplications>[0];
    const result = await resolveTeamCredentialResourceCatalogApplications(input);
    expect(result.map(({ protocol }) => protocol)).toEqual(['openai-chat', 'openai-responses']);
    await expect(resolveTeamCredentialResourceCatalogApplications({
      ...input, agentTargetKeys: ['agent:acme.example/a-stale'],
    })).rejects.toMatchObject({ status: 'unavailable', reason: 'projection_unavailable' });
  });
});

describe('resolveTeamCredentialSourceModelCatalog', () => {
  const application = {
    agentTargetKey: 'agent:acme.example/responses',
    implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
    endpointTemplateId: 'cliproxyapi-openai-responses',
    protocol: 'openai-responses' as const,
  };

  it('serves the broker from its own source projection, with no recipient catalog in the path', async () => {
    const projectModels = vi.fn(async (request: DaemonProviderModelProjectionRequestV1) =>
      projection(request.agentTargetKey, 'source-model'));
    const catalog = await resolveTeamCredentialSourceModelCatalog({
      machineId: 'broker-machine', teamId: 'team-1', resourceId: 'resource-1', resourceRevision: 4,
      source, application, projectModels,
    });

    expect(projectModels).toHaveBeenCalledWith({
      machineId: 'broker-machine',
      agentTargetKey: application.agentTargetKey,
      providerConnection: {
        connectionId: source.connectionId,
        expectedConnectionSecurityFingerprint: source.connectionSecurityFingerprint,
      },
      mode: 'picker',
    });
    expect(catalog).toMatchObject({
      resourceId: 'resource-1',
      resourceRevision: 4,
      sourceRevision: 'source-revision',
      application,
    });
    expect(catalog?.rows.map((row) => row.descriptor.id)).toEqual(['source-model']);
    expect(catalog?.resolveCanonicalModelId('source-model')).toBe('source-model');
  });

  it('is unavailable when the source serves no row for that exact application', async () => {
    await expect(resolveTeamCredentialSourceModelCatalog({
      machineId: 'broker-machine', teamId: 'team-1', resourceId: 'resource-1', resourceRevision: 4,
      source,
      application: { ...application, endpointTemplateId: 'cliproxyapi-openai-chat', protocol: 'openai-chat' },
      projectModels: async (request) => projection(request.agentTargetKey, 'source-model'),
    })).resolves.toBeNull();
  });
});
