import { describe, expect, it } from 'vitest';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';

import { resolveSessionStartBackendTarget, resolveSessionStartModelSelection } from './resolveSessionStartModelSelection';

describe('Session startup target and strict model ingress', () => {
  it('carries the admitted definition past an abstract runner routing id and refuses a different model definition', () => {
    const agentTarget = {
      kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
      definitionId: 'qa-a-acp-alpha',
    };
    const target = resolveSessionStartBackendTarget({ agentTarget, backendId: 'custom-acp' });
    const selection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 30,
      ref: {
        agentTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:qa-a-acp-alpha',
        providerConnectionId: null,
        modelId: 'ollama/qwen2.5:3b',
      },
    });
    expect(resolveSessionStartModelSelection({ backendTarget: target, canonicalSelection: selection })).toEqual(selection);
    expect(() => resolveSessionStartModelSelection({
      backendTarget: resolveSessionStartBackendTarget({
        agentTarget: { ...agentTarget, definitionId: 'qa-c-exact-args' },
        backendTarget: agentTarget,
        backendId: 'custom-acp',
      }),
      canonicalSelection: selection,
    })).toThrowError(expect.objectContaining({ code: 'model_selection_agent_target_mismatch' }));
    expect(resolveSessionStartModelSelection({
      backendTarget: resolveSessionStartBackendTarget({ backendId: 'codex' }),
      legacyModelId: 'native-model',
      nowMs: 30,
    })?.ref).toEqual({ agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'native-model' });
  });
});
