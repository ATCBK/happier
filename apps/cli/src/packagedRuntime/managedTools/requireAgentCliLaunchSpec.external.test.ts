import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { detectCliSnapshotOnDaemonPath } from '@/capabilities/snapshots/cliSnapshot';
import { requireAgentCliLaunchSpec } from './requireAgentCliLaunchSpec';

const tempDirs = new Set<string>();
const envScope = createEnvKeyScope(['PATH']);

function externalAgent(binaryName?: string) {
  return projectManifestAgentContribution({
    pluginId: 'acme.launch', provenance: 'external', source: { kind: 'path' },
    definition: PluginAgentContributionV2Schema.parse({
      id: 'agent', title: 'Acme Agent', runtime: { kind: 'custom' }, primary: 'sessions',
      capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
      ...(binaryName ? { cli: {
        executable: { binaryName, sourcePreference: 'system-first', knownUserBinDirSuffixes: null },
        install: { managed: null, manual: { kind: 'none' } },
        auth: { support: 'status_only', environmentVariables: ['ACME_AGENT_KEY'], loginLaunches: [] },
      } } : {}),
    }),
  });
}

async function publishAgents(agents: ReturnType<typeof externalAgent>[]) {
  // Lookup never activates plugins. Project real declarations and publish them
  // through the registry lifecycle rather than mocking catalog internals.
  const registry = await resolveExecutablePluginRuntimeRegistry({
    pluginIds: [],
    contributes: createResolvedContributionRegistry({ agents, activationTargets: [] }),
    currentGlobalExternalSessionsRouter: pluginReloadController.currentGlobalExternalSessions,
    targetedContributions: pluginReloadController.getTargetedContributionsOwner(),
  });
  await pluginReloadController.adoptPreparedRuntimeRegistry({
    registry, changedPluginIds: [], runningSessionDisposition: 'retainRunningSessions',
  });
}

afterEach(async () => {
  envScope.restore();
  await publishAgents([]);
  for (const dir of tempDirs) await removeTempDir(dir);
  tempDirs.clear();
});
afterAll(async () => { await pluginReloadController.shutdown(); });

describe('requireAgentCliLaunchSpec external Agent metadata', () => {
  it('resolves the active manifest contribution for an external Agent', async () => {
    const root = await createTempDir('happier-external-agent-launch-');
    tempDirs.add(root);
    const agent = externalAgent('acme-cli');
    const executable = await writeExecutableShim({ dir: root, fileName: 'acme-cli', contents: '#!/bin/sh\necho ok\n' });
    await publishAgents([agent]);
    expect(requireAgentCliLaunchSpec(agent.id, { processEnv: { PATH: root } })).toEqual({
      source: 'system', resolvedPath: executable, command: executable, args: [], providerExitOwnership: 'direct',
    });
  });

  it('fails closed when an active Agent contribution has no runtime descriptor', async () => {
    const agent = externalAgent();
    await publishAgents([agent]);
    expect(() => requireAgentCliLaunchSpec(agent.id, { processEnv: { PATH: '' } }))
      .toThrow(`Missing agent CLI runtime metadata for '${agent.id}'`);
  });

  it('detects an external Agent added after the catalog was primed and follows its replacement', async () => {
    const root = await createTempDir('happier-external-agent-snapshot-');
    tempDirs.add(root);
    const pathDir = join(root, 'bin');
    await mkdir(pathDir, { recursive: true });
    await publishAgents([]);
    const { AGENTS } = await import('@/agent/catalog/registry');
    const agent = externalAgent('acme-cli');
    expect(AGENTS).not.toHaveProperty(agent.id);
    envScope.patch({ PATH: pathDir });
    for (const [binaryName, version] of [['acme-cli', '1.2.3'], ['current-acme', '2.3.4']] as const) {
      const currentAgent = externalAgent(binaryName);
      const executable = await writeExecutableShim({
        dir: pathDir, fileName: binaryName, contents: `#!/bin/sh\necho "acme ${version}"\n`,
      });
      await publishAgents([currentAgent]);
      expect(requireAgentCliLaunchSpec(currentAgent.id)).toMatchObject({ source: 'system', resolvedPath: executable });
      const snapshot = await detectCliSnapshotOnDaemonPath({ requestedCliNames: [currentAgent.id], bypassCache: true });
      expect(snapshot.clis[currentAgent.id]).toMatchObject({
        available: true, resolvedPath: executable, resolutionSource: 'system', version,
      });
    }
  });
});
