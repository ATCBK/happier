import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentContribution } from '@happier-dev/plugin-sdk/agents';
import type { AgentAcpRuntimeOptions, AgentSessionOpenRequest, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAgentLaunchObserver, type AgentLaunchObserverBoundaries } from '@happier-dev/plugin-sdk/testing';

import { prepareAcpSessionSkills } from '../runtime/definition/skillsSessionDelivery';
import { prepareNativeSessionConfig } from '../runtime/definition/nativeSessionConfig';

/** The plugin's host ACP boundary uses the real launch-file owners. The full
 * composer/subprocess seam is exercised by createPublicAcpSession.skillsDelivery.test.ts. */
export async function createSkillDeliveryPluginFixture(agent: AgentContribution) {
  const home = await mkdtemp(join(tmpdir(), 'happier-plugin-skill-native-'));
  const skills = 'skills' in agent.capabilities ? agent.capabilities.skills : undefined;
  for (const parts of skills?.nativeRoots?.user ?? []) {
    const root = join(home, ...parts);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'retained-native-file'), 'Retained native bytes.');
  }
  const observer = createAgentLaunchObserver({ home });
  const boundaries = observer.boundaries as AgentLaunchObserverBoundaries;
  return {
    home,
    observeLaunch: observer.observeLaunch,
    async open(request: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions): Promise<AgentSessionRuntime> {
      boundaries.reset();
      const env = { HOME: home, ...request.launchEnvironment?.values };
      const declaration = options.definition?.skills?.sessionDelivery;
      let delivery: Awaited<ReturnType<typeof prepareAcpSessionSkills>> | undefined;
      if (request.skills && declaration) {
        if (declaration.kind === 'native_config_skills_dir') {
          const native = options.definition?.mcp?.nativeSessionConfig;
          if (!native) throw new Error('Native skills require a config-root declaration.');
          delivery = await prepareNativeSessionConfig({ declaration: native, cwd: request.cwd, env,
            mcpServers: undefined, skills: { subdirectory: declaration.subdirectory, delivery: request.skills } });
        } else {
          delivery = await prepareAcpSessionSkills({ declaration, skills: request.skills, cwd: request.cwd, env });
        }
      }
      if (options.transport.kind !== 'stdio') throw new Error('Expected stdio ACP.');
      boundaries.recordLaunch({ argv: options.transport.args ?? [], env: { ...env, ...delivery?.env } });
      return {
        skillsDelivered: !request.skills || Boolean(delivery),
        async send() { return { status: 'admitted' }; },
        watch() { return { dispose() {} }; },
        async dispose() { delivery?.cleanup(); },
      };
    },
    async dispose() { await rm(home, { recursive: true, force: true }); },
  };
}
