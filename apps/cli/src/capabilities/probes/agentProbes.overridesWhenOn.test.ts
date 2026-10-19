import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentModelOptionSchema } from '@happier-dev/protocol';
import type { AgentCatalogEntry } from '@/agent/catalog/types';

import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';
import { probeAgentConfigOptionsBestEffort } from './agentConfigOptionsProbe';

const probeModelsRawMock = vi.fn();
const probeConfigOptionsRawMock = vi.fn();
// The plugin-native observations are the boundary; host resolution and normalization stay real.
const catalogEntry = {
  id: 'example.overrides/agent', cliSubcommand: 'example.overrides/agent', vendorResumeSupport: 'unsupported',
  getPreflightSessionControlsProbeAdapter: async () => ({ failureCacheStrategy: 'cooldown' as const,
    probeModelsRaw: probeModelsRawMock, probeConfigOptionsRaw: probeConfigOptionsRawMock }),
} satisfies AgentCatalogEntry;

/**
 * Exactly what a producing agent is allowed to publish (Claude's `ultracode`), built through the
 * canonical option contract so the probe is fed a real producer shape rather than a stand-in.
 */
const OVERRIDING_OPTION = AgentModelOptionSchema.parse({
  id: 'ultracode',
  name: 'Ultracode',
  description: 'Maximum coding effort. Forces XHigh Thinking effort while enabled.',
  type: 'boolean',
  currentValue: 'false',
  overridesWhenOn: { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' },
});

const EXPECTED_RULE = { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' };

describe('agent control probes preserve producer-declared option override rules', () => {
  beforeEach(() => {
    resetAgentModelsProbeCacheForTests();
    probeModelsRawMock.mockReset();
    probeConfigOptionsRawMock.mockReset();
  });

  it('keeps descriptor-owned model facts on a dynamically probed model', async () => {
    probeModelsRawMock.mockResolvedValueOnce([{
      id: 'claude-opus-5',
      name: 'Opus 5',
      contextWindowTokens: 1_000_000,
      extendedContextModelId: 'claude-opus-5[1m]',
      modelOptions: [OVERRIDING_OPTION],
    }]);

    const result = await probeAgentModelsBestEffort({
      agentId: catalogEntry.id,
      catalogEntry,
      cwd: '/repo',
      timeoutMs: 100,
    });

    expect(result.source).toBe('dynamic');
    const probed = result.availableModels.find((model) => model.id === 'claude-opus-5');
    expect(probed).toMatchObject({
      contextWindowTokens: 1_000_000,
      extendedContextModelId: 'claude-opus-5[1m]',
    });
    expect(probed?.modelOptions?.[0]?.overridesWhenOn).toEqual(EXPECTED_RULE);
  });

  it('keeps overridesWhenOn on a dynamically probed config option', async () => {
    probeConfigOptionsRawMock.mockResolvedValueOnce([OVERRIDING_OPTION]);

    const result = await probeAgentConfigOptionsBestEffort({
      agentId: catalogEntry.id,
      catalogEntry,
      cwd: '/repo-config-options',
      timeoutMs: 100,
    });

    expect(result.source).toBe('dynamic');
    expect(result.configOptions[0]?.overridesWhenOn).toEqual(EXPECTED_RULE);
  });

  it('drops a probed rule the producer contract forbids rather than publishing it', async () => {
    probeModelsRawMock.mockResolvedValueOnce([{
      id: 'claude-opus-5',
      name: 'Opus 5',
      modelOptions: [{ ...OVERRIDING_OPTION, overridesWhenOn: { optionIds: [] } }],
    }]);

    const result = await probeAgentModelsBestEffort({
      agentId: catalogEntry.id,
      catalogEntry,
      cwd: '/repo-invalid-rule',
      timeoutMs: 100,
    });

    expect(result.availableModels.find((model) => model.id === 'claude-opus-5')?.modelOptions?.[0])
      .not.toHaveProperty('overridesWhenOn');
  });
});
