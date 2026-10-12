import { expect, it } from 'vitest';
import { createExecutionRunHostBackendFromSessionRuntime, type AgentExecutionRunOpenRequest } from './executionRun.js';
import type { AgentSessionOpenRequest, AgentSessionRuntime } from './session.js';

it.each(['create', 'resume'] as const)('preserves skills through %s Run-to-Session opening', async (kind) => {
  const skills = {
    pluginRoot: '/host/skills/session/runs/run', skillsRoot: '/host/skills/session/runs/run/skills',
    items: [{ name: 'guide', skillId: 'skill-1', digest: 'sha256:abc' }],
    nativeDisables: [{ name: 'native', path: '/user/skills/native/SKILL.md' }],
  };
  const request = {
    runId: 'run', cwd: '/repo', profile: { pluginId: 'fixture', localId: 'default' }, skills,
    ...(kind === 'create' ? { kind, input: { text: 'Use the guide' } } : { kind, checkpointId: 'checkpoint' }),
  } satisfies AgentExecutionRunOpenRequest;
  let opened: AgentSessionOpenRequest | undefined;
  const session: AgentSessionRuntime = {
    async send() { return { status: 'admitted' }; },
    watch() { return { dispose() {} }; },
    dispose() {},
  };
  const runtime = await createExecutionRunHostBackendFromSessionRuntime({
    request, sessionId: 'session',
    openSession(value) { opened = value; return session; },
  });
  try {
    expect(opened).toMatchObject({ kind, skills });
  } finally {
    await runtime.dispose();
  }
});
