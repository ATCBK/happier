import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol/providers/settings/v1';
import { setProviderExperimentalConfirmationV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { hasProviderExperimentalConfirmation } from './compatibility';

describe('source-scoped experimental confirmation', () => {
  it('matches only the exact source, Agent, model and current compatibility fingerprint', () => {
    const target = { kind: 'group' as const,
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'pool-a' };
    const confirmation = { connectionId: ProviderConnectionIdSchema.parse('connected-source:catalog-a'), connectedAccountTarget: target,
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5.5',
      compatibilityFingerprint: 'compatibility:v1:a', confirmedAt: 1 };
    const providerSettings = setProviderExperimentalConfirmationV1(DEFAULT_PROVIDER_SETTINGS_V1, confirmation);
    const input = { ...confirmation, providerSettings,
      confirmationScope: { kind: 'model' as const, modelId: confirmation.modelId } };
    expect(hasProviderExperimentalConfirmation(input)).toBe(true);
    expect(hasProviderExperimentalConfirmation({ ...input,
      connectedAccountTarget: { groupId: target.groupId, service: target.service, kind: target.kind } })).toBe(true);
    for (const changed of [
      { connectionId: ProviderConnectionIdSchema.parse('connected-source:catalog-b') },
      { connectedAccountTarget: { ...target, groupId: 'pool-b' } },
      { agentTargetKey: 'agent:happier.agent.claude/claude' },
      { modelId: 'another-model' },
      { compatibilityFingerprint: 'compatibility:v1:b' },
      { connectedAccountTarget: undefined },
    ]) expect(hasProviderExperimentalConfirmation({ ...input, ...changed })).toBe(false);

    const updated = setProviderExperimentalConfirmationV1(providerSettings, {
      ...confirmation, compatibilityFingerprint: 'compatibility:v1:b', confirmedAt: 2,
    });
    expect(updated.experimentalBindingConfirmations).toHaveLength(1);
    expect(hasProviderExperimentalConfirmation({ ...input, providerSettings: updated })).toBe(false);
    expect(hasProviderExperimentalConfirmation({ ...input, providerSettings: updated,
      compatibilityFingerprint: 'compatibility:v1:b' })).toBe(true);
    expect(updated.connections).toEqual([]);
  });
});
