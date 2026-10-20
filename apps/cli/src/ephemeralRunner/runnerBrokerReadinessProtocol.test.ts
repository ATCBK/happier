import { describe, expect, it } from 'vitest';

import type {
  AgentProviderRequirementsV1,
  ProviderApiKeyCredentialRequirementV1,
} from '@happier-dev/protocol';

import { resolveReviewedRunnerBrokerApplicationCompatibility } from './runnerBrokerReadinessProtocol';

const agent: AgentProviderRequirementsV1 = {
  acceptsProtocols: ['openai-responses', 'openai-chat'],
  required: {},
  credentialSupport: {
    supportsNoAuth: false,
    apiKeyTransports: [{
      destination: { kind: 'httpHeader' as const, names: ['authorization'], formats: ['bearer' as const] },
      protocol: 'openai-responses',
    }],
  },
  authIsolation: { suppressConnectedServiceIds: [], ownedEnvKeys: [] },
  materialization: 'spawnEnv' as const,
  applyPolicy: 'restart_session' as const,
  supportsFreeformModelIds: true,
};

const credential: ProviderApiKeyCredentialRequirementV1 = {
  kind: 'apiKey',
  required: true,
  slotId: 'apiKey',
  transports: [{
    id: 'runtime-bearer',
    uses: ['runtime' as const],
    protocols: ['openai-responses', 'openai-chat'],
    destination: { kind: 'httpHeader' as const, name: 'authorization', format: 'bearer' as const },
  }],
};

const reviewedModel = { id: 'reviewed-model', name: 'Reviewed model' };

const endpoint = (protocol: 'openai-responses' | 'openai-chat') => ({
  id: protocol,
  protocol,
  baseUrl: 'https://provider.example.test/v1',
  capabilities: {
    streaming: 'supported' as const,
    toolRoundTrips: 'supported' as const,
    statefulResponses: 'supported' as const,
    reasoningControls: 'supported' as const,
  },
});

describe('Runner broker readiness reviewed application', () => {
  const application = {
    agentTargetKey: 'agent:happier.agent.codex/codex',
    implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
    endpointTemplateId: 'openai-responses',
    protocol: 'openai-responses' as const,
  };

  it('accepts the exact reviewed compatible endpoint', () => {
    expect(resolveReviewedRunnerBrokerApplicationCompatibility({
      agentTargetKey: 'agent:happier.agent.codex/codex', agent,
      endpoints: [endpoint('openai-responses')], application, credential, model: reviewedModel,
    })).toEqual({ status: 'ready' });
  });

  it('assesses required model capabilities from the exact reviewed model', () => {
    const input = {
      agentTargetKey: application.agentTargetKey,
      agent: { ...agent, required: { toolRoundTrips: true as const } },
      endpoints: [endpoint('openai-responses')], application, credential,
      model: { id: 'reviewed-model', name: 'Reviewed model', capabilities: { toolRoundTrips: 'supported' as const } },
    };
    expect(resolveReviewedRunnerBrokerApplicationCompatibility(input)).toEqual({ status: 'ready' });
    expect(resolveReviewedRunnerBrokerApplicationCompatibility({
      ...input,
      model: { ...input.model, capabilities: { toolRoundTrips: 'unsupported' } },
    })).toEqual({ status: 'unavailable', reason: 'reviewed_application_incompatible' });
  });

  it('rejects an Agent that cannot use the reviewed broker protocol', () => {
    expect(resolveReviewedRunnerBrokerApplicationCompatibility({
      agentTargetKey: application.agentTargetKey,
      agent: { ...agent, acceptsProtocols: ['anthropic'] },
      endpoints: [endpoint('openai-responses')], application, credential, model: reviewedModel,
    })).toEqual({ status: 'unavailable', reason: 'reviewed_application_incompatible' });
  });

  it('fails closed when the reviewed endpoint changed, without treating another endpoint as ambiguous', () => {
    expect(resolveReviewedRunnerBrokerApplicationCompatibility({
      agentTargetKey: 'agent:happier.agent.codex/codex', agent,
      endpoints: [], application, credential, model: reviewedModel,
    })).toEqual({ status: 'unavailable', reason: 'reviewed_application_changed' });
    expect(resolveReviewedRunnerBrokerApplicationCompatibility({
      agentTargetKey: 'agent:happier.agent.codex/codex', agent,
      endpoints: [endpoint('openai-responses'), endpoint('openai-chat')], application, credential, model: reviewedModel,
    })).toEqual({ status: 'ready' });
  });
});
