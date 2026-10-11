import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

function acpProvider(id: string): ProviderUnderTest {
  return {
    id,
    enableEnvVar: `HAPPIER_E2E_PROVIDER_${id.toUpperCase()}`,
    protocol: 'acp',
    traceProvider: id,
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: [] } },
    cli: { subcommand: id },
  };
}

describe('scenarioCatalog: ACP capability/model-set scenarios', () => {
  it('defines acp_probe_capabilities as a real scenario', () => {
    const build = (scenarioCatalog as Record<string, any>).acp_probe_capabilities;
    expect(typeof build).toBe('function');

    const scenario = build(acpProvider('qwen'));
    expect(scenario.id).toBe('acp_probe_capabilities');
    expect(scenario.requiredFixtureKeys).toBeUndefined();
    expect(scenario.requiredAnyFixtureKeys).toBeUndefined();
    expect(typeof scenario.postSatisfy?.run).toBe('function');
  });

  it('uses a longer capabilities probe timeout for gemini ACP', () => {
    const build = (scenarioCatalog as Record<string, any>).acp_probe_capabilities;
    expect(typeof build).toBe('function');

    const geminiScenario = build(acpProvider('gemini'));
    const qwenScenario = build(acpProvider('qwen'));

    expect(geminiScenario.postSatisfy?.timeoutMs).toBeGreaterThan(qwenScenario.postSatisfy?.timeoutMs ?? 0);
  });

  it('accepts the negotiated runtime capability publication of the active session', async () => {
    const scenario = scenarioCatalog.acp_probe_capabilities(acpProvider('codebuddy'));
    const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-acp-cap-publication-'));
    const context = {
      workspaceDir, fixtures: { examples: {} }, traceEvents: [],
      baseUrl: 'http://127.0.0.1:1', token: 'token', sessionId: 'session',
      resumeSessionId: null, secret: new Uint8Array(32), resumeId: null,
    };
    try {
      await writeFile(join(workspaceDir, 'e2e-probe-capabilities.json'), JSON.stringify({
        runtimeCapabilities: {
          localControl: null,
          sessionCapabilities: {
            sessionListing: 'unsupported',
            sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported', protocol: 'acp' },
            sessionRollback: { conversation: 'unsupported' },
          },
        },
      }), 'utf8');
      await expect(scenario.verify?.(context)).resolves.toBeUndefined();
      await writeFile(join(workspaceDir, 'e2e-probe-capabilities.json'), '{}', 'utf8');
      await expect(scenario.verify?.(context)).rejects.toThrow();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('defines acp_set_model_dynamic for dynamic ACP providers', () => {
    const build = (scenarioCatalog as Record<string, any>).acp_set_model_dynamic;
    expect(typeof build).toBe('function');

    const scenario = build(acpProvider('opencode'));
    expect(scenario.id).toBe('acp_set_model_dynamic');
    expect(scenario.requiredFixtureKeys).toBeUndefined();
    expect(scenario.requiredAnyFixtureKeys).toBeUndefined();
    expect(typeof scenario.postSatisfy?.run).toBe('function');
  });

  it('lets provider-owned registries opt ACP providers into dynamic model probing', () => {
    const build = (scenarioCatalog as Record<string, any>).acp_set_model_dynamic;
    expect(typeof build).toBe('function');
    expect(build(acpProvider('qwen')).id).toBe('acp_set_model_dynamic');
    expect(build(acpProvider('kimi')).id).toBe('acp_set_model_dynamic');
  });

  it('defines acp_set_model_inventory for gemini only', () => {
    const build = (scenarioCatalog as Record<string, any>).acp_set_model_inventory;
    expect(typeof build).toBe('function');

    const scenario = build(acpProvider('gemini'));
    expect(scenario.id).toBe('acp_set_model_inventory');
    expect(scenario.requiredFixtureKeys).toBeUndefined();
    expect(scenario.requiredAnyFixtureKeys).toBeUndefined();
    expect(typeof scenario.postSatisfy?.run).toBe('function');
    expect(() => build(acpProvider('codex'))).toThrow(/gemini provider/i);
  });
});
