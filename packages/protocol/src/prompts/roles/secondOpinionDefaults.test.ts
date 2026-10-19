import { describe, expect, it } from 'vitest';
import { buildBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import { resolveRoleSelectionV1 } from './resolveRoleSelectionV1.js';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '../../agents/executionTargetV1.js';

const caller = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' });
const other = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });

describe('Second opinion start defaults', () => {
  it('uses the first enabled different Agent and drops caller model and effort', () => {
    const resolved = resolveRoleSelectionV1({ roleId: 'second_opinion',
      defaultEngine: { agentTargetKey: caller, modelId: 'caller-model', effort: 'high' },
      availableAgentTargetKeys: [caller, other, buildBackendTargetKeyV2({ kind: 'backend', backendId: 'gemini' })],
    });
    if (!resolved.ok) throw new Error(resolved.refusal.code);
    expect(resolved.selection.engine).toEqual({ agentTargetKey: other });
  });

  it('does not treat a configured variant of the caller as another Agent family', () => {
    const configuredCaller = buildBackendTargetKeyV2({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'caller' });
    const variant = buildBackendTargetKeyV2({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'alternate-login' });
    const resolved = resolveRoleSelectionV1({ roleId: 'second_opinion', defaultEngine: { agentTargetKey: configuredCaller },
      availableAgentTargetKeys: [variant, other],
    });
    expect(resolved).toMatchObject({ ok: true, selection: { engine: { agentTargetKey: other } } });
  });

  it('falls back to the caller when no other Agent is enabled', () => {
    const engine = { agentTargetKey: caller, modelId: 'caller-model' };
    expect(resolveRoleSelectionV1({ roleId: 'second_opinion', defaultEngine: engine,
      availableAgentTargetKeys: [caller],
    })).toMatchObject({ ok: true, selection: { engine } });
  });

  it('keeps explicit role overrides and ordinary role defaults', () => {
    expect(resolveRoleSelectionV1({ roleId: 'second_opinion', defaultEngine: { agentTargetKey: caller },
      availableAgentTargetKeys: [caller, other],
      runOverrides: [{ roleId: 'second_opinion', engine: { agentTargetKey: caller, modelId: 'chosen-model' } }],
    })).toMatchObject({ ok: true, selection: { engine: { agentTargetKey: caller, modelId: 'chosen-model' } } });
    expect(resolveRoleSelectionV1({ roleId: 'builder', defaultEngine: { agentTargetKey: caller },
      availableAgentTargetKeys: [caller, other],
    })).toMatchObject({ ok: true, selection: { engine: { agentTargetKey: caller } } });
  });
});
