import {
  derivePluginDaemonContributionRegistrationRights,
  ingestPluginManifestV2,
} from '@happier-dev/protocol';
import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { describe, expect, it } from 'vitest';

import { AGENT_DEFINITION } from './agent/definition.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('FX plugin manifest', () => {
  it('retains the released v0.0.13 native permission presets', () => {
    // Installer latest.txt resolves to v0.0.13, commit 4d966e272cfc4296cdf703f409480088cf2e72ba.
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.runtime).toMatchObject({
      kind: 'acp',
      definition: { permissionModeMapping: { default: null, 'read-only': 'ask', 'safe-yolo': 'code' } },
    });
  });
  it('ingests and declares the `fx acp` session runtime without a custom factory', () => {
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST).toHaveProperty('entrypoints.daemon', './.happier-plugin/daemon.js');
    expect(PLUGIN_MANIFEST.contributes.agents).toEqual([
      expect.objectContaining({
        id: 'fx',
        runtime: expect.objectContaining({
          kind: 'acp',
          transport: expect.objectContaining({
            kind: 'stdio',
            executable: { kind: 'systemTool', id: 'fx-cli' },
            // FX's documented ACP contract is exactly `fx acp`.
            args: ['acp'],
          }),
        }),
        primary: 'sessions',
      }),
    ]);
    expect(PLUGIN_MANIFEST.contributes.agents[0]).not.toHaveProperty('factory');
  });

  it('projects capabilities from the agent definition through the canonical owner', () => {
    const [agent] = PLUGIN_MANIFEST.contributes.agents;
    // The manifest must equal the canonical projection of its own definition:
    // hand-copied capability blocks (and a session-primary `executionRuns`
    // restatement) drift from the definition and fail manifest ingest.
    expect(agent.capabilities).toEqual(
      projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
        surfaces: ['externalSessions'],
        sessions: {
          open: ['create', 'resume'],
          delivery: ['newTurn', 'followUp'],
          cancel: true,
          configuration: true,
          executionRunContext: { versions: [1] },
        },
      }),
    );
    // Terminal hosting is derived from `localControl.attachStrategy`, and tool
    // delivery from the definition's tool facts — never restated by hand.
    expect(agent.capabilities).toMatchObject({
      surfaces: ['terminal', 'externalSessions'],
      tools: { delivery: 'native_mcp' },
    });
    expect(agent.capabilities).not.toHaveProperty('executionRuns');
  });

  it('declares one native source with ACP-compatible session identities', () => {
    const [agent] = PLUGIN_MANIFEST.contributes.agents;
    expect(agent.capabilities.surfaces).toContain('externalSessions');
    expect(agent.surfaces?.externalSession).toEqual({
      sources: [{
        sourceKind: 'fxHome',
        contentSearch: true,
        schema: { fields: [{ kind: 'literal', name: 'kind', value: 'fxHome' }] },
        key: { segments: [{ kind: 'literal', value: 'fxHome' }] },
        instances: [{ kind: 'default', constants: {} }],
      }],
    });
    expect(agent.surfaces?.externalSession).not.toHaveProperty('externalLinkedTakeover');
    expect(agent).toMatchObject({ primary: 'sessions', runtime: { kind: 'acp' } });
    expect(agent.capabilities.sessions?.open).toContain('resume');
  });

  it('requires the native External Sessions reader through the public activation ABI', () => {
    expect(derivePluginDaemonContributionRegistrationRights(
      PLUGIN_MANIFEST.contributes as unknown as Readonly<Record<string, unknown>>,
    )).toContainEqual(expect.objectContaining({
      family: 'agents',
      localId: 'fx',
      requiredFields: expect.arrayContaining(['terminal', 'externalSessions']),
    }));
  });
});
