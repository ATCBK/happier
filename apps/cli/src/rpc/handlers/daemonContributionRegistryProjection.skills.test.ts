import { describe, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { pluginSkillIdV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { RpcHandler } from '@/api/rpc/types';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';

describe('plugin skill source selection', () => {
  it('reads one addressed package bundle through the existing authenticated catalog handler', async () => {
    const pluginId = 'com.acme.skill-source';
    const author = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
      skills: { check: { directory: './skills/check' } } });
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: author.manifest,
      files: { 'daemon.mjs': 'export function activate() {}',
        'skills/check/SKILL.md': '---\nname: check\n---\nInstructions supplied on machine A.',
        'skills/check/reference.txt': 'Supporting package content' } }] });
    try {
      const handlers = new Map<string, RpcHandler>();
      registerDaemonContributionRegistryProjectionHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
        resolveRuntimeRegistry: async () => runtime.registry,
        resolveGeneration: async () => runtime.controller.getState().generation,
        resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_skill_sources', machineId: 'source-A' }),
      });
      const skillId = pluginSkillIdV1({ pluginId, localId: 'check' });
      const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await handlers
        .get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!({ machineId: 'source-A', selection: 'skills', skillIds: [skillId] }));
      expect(response).toMatchObject({ pluginSkills: [{ skillId, provenance: { kind: 'plugin', pluginId } }] });
      expect(response.pluginSkills![0]!.files.map(file => file.path).sort()).toEqual(['SKILL.md', 'reference.txt'].sort());
      expect(response.projection.familiesById.skills?.entriesById[`${pluginId}/check`]).toBeDefined();
      const absent = await handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!({
        machineId: 'source-A', selection: 'skills', skillIds: ['plugin:absent/check'] });
      expect(absent).toMatchObject({ pluginSkills: [] });
    } finally { await runtime.dispose(); }
  });
});
