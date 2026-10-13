import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import type { AgentExecutionRunRuntimeContextV1, AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAgentLaunchObserver, runAgentSkillDeliveryContract, type AgentLaunchObserverBoundaries } from '@happier-dev/plugin-sdk/testing';
import type { ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';

import { PLUGIN_MANIFEST } from '../manifest.js';
import { createOpenCodeAgentRuntime } from './runtime/nativeRuntime.js';
import { managedServiceHandle } from './runtime/server/assembly.managedServices.testkit.js';

const home = mkdtempSync(join(tmpdir(), 'happier-opencode-skill-home-'));
for (const root of ['.config/opencode/skills', '.claude/skills', '.agents/skills']) {
  mkdirSync(join(home, root, 'retained-native'), { recursive: true });
  writeFileSync(join(home, root, 'retained-native', 'SKILL.md'), 'Native skill bytes stay unchanged.');
}
writeFileSync(join(home, '.config', 'opencode', 'opencode.jsonc'), '{"skills":{"paths":["native-config-root"]}}');
afterAll(() => rmSync(home, { recursive: true, force: true }));
const observer = createAgentLaunchObserver({ home });
const boundaries = observer.boundaries as AgentLaunchObserverBoundaries;

function sessionBoundary(hasSkills: boolean): AgentSessionRuntime {
  // The real host ACP composer reports false when the definition has no skill delivery knob.
  return { ...(hasSkills ? { skillsDelivered: false } : {}), send: async () => ({ status: 'admitted' }), watch: () => ({ dispose() {} }), dispose: async () => {} };
}

function context() {
  const store = new Map<string, unknown>();
  // Only host services, OS execution and native HTTP/ACP transports are replaced.
  return {
    signal: new AbortController().signal,
    session: { id: 'skill-delivery-contract', services: {} },
    services: {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      connectedAccounts: { getBinding: async () => null, watch(_purpose: string, listener: () => void) { listener(); return { dispose() {} }; } },
      storage: { daemonSession: { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: unknown) => { store.set(key, value); } } },
      interactions: { askQuestions: async () => ({ status: 'userCancelled' }), requestApproval: async () => ({ status: 'approved' }) },
      exec: { systemTools: { resolve: async () => ({ executablePath: '/fixture/opencode' }) } },
      managedServices: { supervise: async (spec: ManagedServiceSpec) => {
        boundaries.recordLaunch({ argv: spec.mode.kind === 'spawn' ? spec.mode.launch.args ?? [] : [],
          env: spec.mode.kind === 'spawn' ? spec.mode.launch.env : {} });
        return managedServiceHandle({ baseUrl: 'http://127.0.0.1:49213', request: async (input) => {
          const path = input.pathAndQuery.split('?')[0];
          const payload = path === '/global/health' ? { healthy: true }
            : path.startsWith('/api/session') ? { data: { id: 'oc-skill-contract' } }
              : path.startsWith('/session') ? { id: 'oc-skill-contract' } : {};
          return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify(payload)).body };
        } });
      } },
    },
    protocols: { acp: {
      open: async (prepared: AgentSessionOpenRequest, options: Parameters<AgentSessionRuntimeContext['protocols']['acp']['open']>[1]) => {
        boundaries.recordLaunch({ argv: options?.transport.args ?? [], env: prepared.launchEnvironment?.values });
        return sessionBoundary(prepared.skills !== undefined);
      },
      openExecutionRunV1: async (prepared: { skills?: unknown; launchEnvironment?: { values: Readonly<Record<string, string>> } }, options: { transport: { args: readonly string[] } }) => {
        boundaries.recordLaunch({ argv: options.transport.args, env: prepared.launchEnvironment?.values });
        return sessionBoundary(prepared.skills !== undefined);
      },
    } },
  };
}

function factory() {
  return createOpenCodeAgentRuntime({ plugin: { id: 'happier.agent.opencode', version: '0.0.0' }, agent: { id: 'opencode' }, signal: new AbortController().signal });
}

function prepare(request: AgentSessionOpenRequest, mode: 'server' | 'acp', external: boolean, v2: boolean): AgentSessionOpenRequest {
  return { ...request,
    launchEnvironment: { values: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), HAPPIER_OPENCODE_BACKEND_MODE: mode,
      ...(external ? { HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:49213' } : {}) }, unset: [] },
    ...(v2 ? { configuration: { model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: null, updatedAtMs: 0 },
      options: { opencodeCliGeneration: { value: 'v2', updatedAtMs: 0 } } } } : {}),
  };
}

async function openSession(request: AgentSessionOpenRequest, mode: 'server' | 'acp' = 'server', external = false, v2 = false) {
  boundaries.reset();
  return await factory().sessions!.open(prepare(request, mode, external, v2), context() as unknown as AgentSessionRuntimeContext);
}

async function openRun(request: AgentSessionOpenRequest, mode: 'server' | 'acp' = 'server', external = false, v2 = false): Promise<AgentSessionRuntime> {
  boundaries.reset();
  const prepared = prepare(request, mode, external, v2);
  const ctx = context();
  const runtime = await factory().sessions!.executionRunContextV1!.open({
    kind: 'resume', checkpointId: 'oc-skill-contract', runId: 'opencode-skill-run', cwd: request.cwd,
    profile: { pluginId: 'happier.agent.opencode', localId: 'opencode' }, skills: request.skills,
    launchEnvironment: prepared.launchEnvironment, configuration: prepared.configuration,
  }, { ...ctx, session: undefined, scope: { kind: 'execution_run', executionRunId: 'opencode-skill-run' }, executionRun: { id: 'opencode-skill-run', services: {} } } as unknown as AgentExecutionRunRuntimeContextV1);
  // The shared launch kit consumes disposal and delivery facts for a Run variant.
  return runtime as unknown as AgentSessionRuntime;
}

const agent = PLUGIN_MANIFEST.contributes.agents.find((candidate) => candidate.id === 'opencode');
if (!agent) throw new Error('OpenCode Agent contribution is missing');
it('keeps native delivery unsupported while retaining the known native roots', () => {
  expect(agent.capabilities.skills).toEqual({ delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported',
    nativeRoots: { user: [['.config', 'opencode', 'skills'], ['.claude', 'skills'], ['.agents', 'skills']],
      project: [['.opencode', 'skills'], ['.opencode', 'skill'], ['.claude', 'skills'], ['.agents', 'skills']] } });
});
runAgentSkillDeliveryContract({ agent, openSession, observeLaunch: observer.observeLaunch, variants: [
  { id: 'managed Session', open: openSession, expect: 'unsupported' },
  { id: 'managed Run', open: openRun, expect: 'unsupported' },
  { id: 'ACP Session', open: (request) => openSession(request, 'acp'), expect: 'unsupported' },
  { id: 'ACP Run', open: (request) => openRun(request, 'acp'), expect: 'unsupported' },
  { id: 'V2 managed Session', open: (request) => openSession(request, 'server', false, true), expect: 'unsupported' },
  { id: 'V2 managed Run', open: (request) => openRun(request, 'server', false, true), expect: 'unsupported' },
  { id: 'V2 ACP Session', open: (request) => openSession(request, 'acp', false, true), expect: 'unsupported' },
  { id: 'V2 ACP Run', open: (request) => openRun(request, 'acp', false, true), expect: 'unsupported' },
  { id: 'external attach Session', open: (request) => openSession(request, 'server', true), expect: 'unsupported' },
  { id: 'external attach Run', open: (request) => openRun(request, 'server', true), expect: 'unsupported' },
] });
