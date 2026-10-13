import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionOpenRequest, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAgentLaunchObserver, runAgentSkillDeliveryContract, type AgentLaunchObserverBoundaries } from '@happier-dev/plugin-sdk/testing';

import { PLUGIN_MANIFEST } from '../manifest.js';
import { startCodexAppServerRuntime } from './runtime/appServer/runtime.js';
import { createCodexNativeAppServerSessionRuntime } from './runtime/appServer/native.js';
import { withCodexNativeAttachFixture } from './runtime/appServer/runtime.nativeAttach.test-support.js';

let home: string;
let observer: ReturnType<typeof createAgentLaunchObserver>;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'happier-codex-skill-home-'));
  for (const root of ['.claude', '.agents', '.codex', '.config/opencode', '.copilot', '.gemini', '.pi', '.qwen']) {
    const path = join(home, root);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'retained-native-config'), `Keep ${root} byte-identical.\n`);
  }
  observer = createAgentLaunchObserver({ home });
});
afterAll(async () => { await rm(home, { recursive: true, force: true }); });

async function openSession(request: AgentSessionOpenRequest, appServerTransport?: 'daemonProxy'): Promise<AgentSessionRuntime> {
  const boundaries = observer.boundaries as AgentLaunchObserverBoundaries;
  boundaries.reset();
  let resolveReady!: (runtime: AgentSessionRuntime) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<AgentSessionRuntime>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const fixtureDone = withCodexNativeAttachFixture(async ({ runtime }) => {
    await startCodexAppServerRuntime(runtime);
    const session = createCodexNativeAppServerSessionRuntime(runtime, request.sessionId);
    session.watch(boundaries.recordRuntimeEvent);
    resolveReady({ ...session, async dispose() {
      try { await session.dispose(); }
      finally { release(); await fixtureDone; }
    } });
    await released;
  }, { skills: request.skills, directory: request.cwd, processEnv: { HOME: home }, observer: boundaries, appServerTransport });
  void fixtureDone.catch(rejectReady);
  return await ready;
}

const agent = PLUGIN_MANIFEST.contributes.agents?.find((candidate) => candidate.id === 'codex');
if (!agent) throw new Error('Codex Agent contribution is missing.');
runAgentSkillDeliveryContract({
  agent,
  openSession,
  observeLaunch: () => observer.observeLaunch(),
  async invokeSkill(runtime, name) {
    const launch = observer.observeLaunch();
    const rootsRequest = launch.appServerRequests.find(request => request.method === 'skills/extraRoots/set');
    const params = rootsRequest?.params;
    const roots = params && typeof params === 'object' ? Reflect.get(params, 'extraRoots') : undefined;
    if (!Array.isArray(roots) || typeof roots[0] !== 'string') throw new Error('No delivered skill root');
    const path = join(roots[0], name, 'SKILL.md');
    const result = await runtime.send({ inputIds: ['skill-contract-input'], input: { text: `Use $${name}`,
      structuredInput: { v: 1, skillMentions: [{ id: name, name, path }] } },
      delivery: { kind: 'newTurn', turnId: 'skill-contract-turn' } });
    expect(result.status).toBe('admitted');
    await vi.waitFor(() => expect(observer.observeLaunch().runtimeEvents).toContainEqual(expect.objectContaining({ kind: 'skill-usage' })));
  },
  variants: [
    { id: 'app-server', open: openSession, expect: 'delivers' },
    { id: 'daemonProxy', open: (request) => openSession(request, 'daemonProxy'), expect: 'unsupported' },
  ],
});

it('reports repeated native skill mentions once per name, and again in the next turn', async () => {
  await withCodexNativeAttachFixture(async ({ runtime }) => {
    await startCodexAppServerRuntime(runtime);
    const session = createCodexNativeAppServerSessionRuntime(runtime, 'skill-mentions');
    const events: unknown[] = [];
    session.watch(event => events.push(event));
    try {
      for (const turnId of ['first-skill-turn', 'next-skill-turn']) {
        const mentions = [{ id: 'first', name: 'contract-skill', path: '/native/contract-skill/SKILL.md' },
          { id: 'duplicate', name: 'contract-skill', path: '/native/contract-skill/SKILL.md' }];
        const result = await session.send({ inputIds: [turnId], input: { text: 'Use $contract-skill',
          structuredInput: { v: 1, skillMentions: mentions } }, delivery: { kind: 'newTurn', turnId } });
        expect(result.status).toBe('admitted');
        await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: 'turn-complete', turnId })));
      }
      expect(events.filter(event => event !== null && typeof event === 'object' && Reflect.get(event, 'kind') === 'skill-usage'))
        .toEqual(['first-skill-turn', 'next-skill-turn'].map(turnId => expect.objectContaining({ turnId,
          skills: [{ name: 'contract-skill', path: '/native/contract-skill/SKILL.md' }] })));
    } finally { await session.dispose(); }
  }, { turnIdForStart: occurrence => `fixture-turn-${occurrence}`, onTurnStart({ socket, turnId }) {
    socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'fresh-thread',
      turn: { id: turnId, status: 'completed', items: [] } } }));
  } });
});
