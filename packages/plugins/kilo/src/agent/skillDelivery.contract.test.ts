import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentAcpRuntimeOptions,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentExecutionRunRuntimeContextV1,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { createAgentLaunchObserver, runAgentSkillDeliveryContract, type AgentLaunchObserverBoundaries } from '@happier-dev/plugin-sdk/testing';

import { PLUGIN_MANIFEST } from '../manifest.js';
import { createKiloAgentRuntime } from './runtime/factory.js';

let home: string;
let observer: ReturnType<typeof createAgentLaunchObserver>;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'happier-kilo-skill-home-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  for (const root of ['.kilo', '.agents', '.claude']) {
    const directory = join(home, root, 'skills');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'retained'), `Keep ${root}.\n`);
  }
  observer = createAgentLaunchObserver({ home });
});
afterAll(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

const configuration = {
  mode: { value: null, updatedAtMs: 0 },
  model: { value: null, updatedAtMs: 0 },
  permissionIntent: { value: 'read-only' as const, updatedAtMs: 0 },
  options: {},
};

function recordLaunch(request: AgentSessionOpenRequest | AgentExecutionRunOpenRequest, options: AgentAcpRuntimeOptions) {
  if (options.transport.kind !== 'stdio') throw new Error('Kilo must use stdio ACP.');
  const boundary = observer.boundaries as AgentLaunchObserverBoundaries;
  const env = { ...request.launchEnvironment?.values };
  for (const key of request.launchEnvironment?.unset ?? []) delete env[key];
  boundary.recordLaunch({ argv: options.transport.args ?? [], env: { ...env, ...options.transport.env } });
}

async function openSession(request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> {
  (observer.boundaries as AgentLaunchObserverBoundaries).reset();
  const agent = await createKiloAgentRuntime({ plugin: { id: 'happier.agent.kilo', version: '0.0.0' }, agent: { id: 'kilo' }, signal: new AbortController().signal });
  // The public host ACP port is outside plugin ownership. Its refusal is supporting
  // evidence; B2/U7 owns the host composer's real Session/Run refusal check.
  const context = {
    protocols: { acp: { async open(forwarded: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) {
      recordLaunch(forwarded, options);
      return {
        skillsDelivered: forwarded.skills ? false : undefined,
        send: async () => ({ status: 'admitted' as const }),
        cancel: async ({ turnId }: { turnId: string }) => ({ status: 'requested' as const, turnId }),
        watch: () => ({ dispose() {} }), dispose: async () => {},
      } satisfies AgentSessionRuntime;
    } } },
  } as unknown as AgentSessionRuntimeContext;
  return await agent.sessions.open({ ...request, configuration, launchEnvironment: {
    values: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), ...request.launchEnvironment?.values },
    unset: request.launchEnvironment?.unset ?? [],
  } }, context);
}

const contribution = PLUGIN_MANIFEST.contributes.agents.find(agent => agent.id === 'kilo');
if (!contribution) throw new Error('Kilo Agent contribution is missing.');
runAgentSkillDeliveryContract({ agent: contribution, openSession, observeLaunch: () => observer.observeLaunch(), variants: [
  { id: 'create without a proven native knob', open: openSession, expect: 'unsupported' },
  { id: 'resume without a proven native knob', open: request => openSession({ ...request, kind: 'resume', providerSessionId: 'kilo-resume' }), expect: 'unsupported' },
] });

it('keeps Run skills on the host carrier without inventing a native Kilo knob', async () => {
  (observer.boundaries as AgentLaunchObserverBoundaries).reset();
  const agent = await createKiloAgentRuntime({ plugin: { id: 'happier.agent.kilo', version: '0.0.0' }, agent: { id: 'kilo' }, signal: new AbortController().signal });
  const skills = { pluginRoot: join(home, 'run-plugin'), skillsRoot: join(home, 'run-plugin', 'skills'), items: [], nativeDisables: [] };
  let forwardedSkills: AgentExecutionRunOpenRequest['skills'];
  const context = { protocols: { acp: { async openExecutionRunV1(request: AgentExecutionRunOpenRequest, options: AgentAcpRuntimeOptions) {
    forwardedSkills = request.skills;
    recordLaunch(request, options);
    return { send: async () => ({ status: 'admitted' as const }), stop: async () => ({ status: 'requested' as const }), watch: () => ({ dispose() {} }), dispose: async () => {} } satisfies AgentExecutionRunRuntime;
  } } } } as unknown as AgentExecutionRunRuntimeContextV1;
  const run = await agent.sessions.executionRunContextV1?.open({ kind: 'create', runId: 'kilo-run', cwd: home, profile: { pluginId: 'happier.agent.kilo', localId: 'default' }, input: { text: 'Run.' }, configuration, skills, launchEnvironment: { values: { HOME: home, XDG_CONFIG_HOME: join(home, '.config') }, unset: [] } }, context);
  try {
    expect(forwardedSkills).toBe(skills);
    expect(JSON.stringify(observer.observeLaunch())).not.toContain(skills.pluginRoot);
    expect(observer.observeLaunch().filesWritten).toEqual([]);
    expect(JSON.parse(observer.observeLaunch().env.KILO_PERMISSION)).toMatchObject({ '*': 'deny', read: 'allow' });
  } finally { await run?.dispose(); }
});
