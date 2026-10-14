import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

import { getVendorResumeSupport } from './catalogHooks';
import { resolveCapabilityApplyAgentFacts } from './capabilityApplyFacts';

describe('session resume through the applied plugin runtime', () => {
  it('demands the Codex resume hook and fences it after its runtime retires', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-resume-catalog-'));
    let unownedRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
    let adopted = false;
    try {
      unownedRegistry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir,
        resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({
          kind: 'development',
          registeredRootId: `resume-catalog-integration:${pluginId}`,
          canonicalRoot: rootPath,
          observedRevision: 1,
        }),
      });
      expect(unownedRegistry.contributes.catalogEntriesById.codex?.getVendorResumeSupport)
        .toBeUndefined();
      const appServer = {
        runtimeDescriptorV1: {
          v: 1 as const,
          agentId: 'codex',
          agent: { backendMode: 'appServer' },
        },
      };
      // An incumbent Session holds its registry; another global catalog must
      // neither replace its declared support nor supply its lazy predicate.
      const capturedSupportsResume = await getVendorResumeSupport('codex', unownedRegistry);
      expect(capturedSupportsResume(appServer)).toBe(true);
      await expect(resolveCapabilityApplyAgentFacts({ agentId: 'codex', metadata: appServer,
        sessionRunning: true, registry: unownedRegistry })).resolves.toMatchObject({ vendorResume: 'experimental' });
      await expect(resolveCapabilityApplyAgentFacts({ agentId: 'codex', metadata: {},
        sessionRunning: true, registry: unownedRegistry })).resolves.toMatchObject({ vendorResume: 'unsupported' });
      await expect(resolveCapabilityApplyAgentFacts({ agentId: 'missing-agent', metadata: appServer,
        sessionRunning: true, registry: unownedRegistry })).resolves.toEqual({ vendorResume: 'unsupported', skillsLiveReload: 'unsupported' });
      await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry: unownedRegistry,
        changedPluginIds: ['happier.agent.codex'],
        durableRevision: 1,
        runningSessionDisposition: 'retainRunningSessions',
      });
      adopted = true;
      unownedRegistry = null;

      // The daemon's ordinary resume check must demand its Agent-owned hook;
      // no earlier preflight or external-session request is required to warm it.
      const supportsResume = await getVendorResumeSupport('codex');
      expect(supportsResume(appServer)).toBe(true);
      expect(supportsResume({})).toBe(false);

      await pluginReloadController.shutdown({ timeoutMs: 5_000 });
      adopted = false;
      expect(supportsResume(appServer)).toBe(false);
      expect(capturedSupportsResume(appServer)).toBe(false);
    } finally {
      if (adopted) await pluginReloadController.shutdown({ timeoutMs: 5_000 });
      await unownedRegistry?.dispose();
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
