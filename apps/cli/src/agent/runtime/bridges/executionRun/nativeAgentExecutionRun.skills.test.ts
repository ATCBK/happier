import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { createCodexAgentRuntime } from '../../../../../../../packages/plugins/codex/src/agent/runtime/engine';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createVoiceSessionContextLease } from './testkit/nativeSessionContext';
import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { createNativeAgentSessionExecutionRunHostRuntime, createNativeAgentSessionInteractionHostRuntime,
  type NativeAgentSessionContextLeaseFactory } from './nativeAgentExecutionRun';

// Daemon HTTP and the Agent runtime are external boundaries; host admission,
// the SDK Run adapter and delivered-skill identity projection remain real.
const usageBoundary = vi.hoisted(() => ({ requests: [] as unknown[] }));
vi.mock('@/daemon/controlClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  recordDaemonSkillUse: async (request: unknown) => { usageBoundary.requests.push(request); },
}));

it.each(['finite', 'retained'] as const)('records only the acknowledged %s Run delivery without a token-usage consumer', async kind => {
  const account = { accountId: 'run-account', serverHttpBaseUrl: 'https://run-home.example' };
  for (const delivery of ['acknowledged', 'refused', 'absent', 'index'] as const) {
    usageBoundary.requests = [];
    const skillObservationEffects: Promise<unknown>[] = [];
    const messages: unknown[] = [];
    const skills = { pluginRoot: '/private/run', skillsRoot: '/private/run/skills', nativeDisables: [],
      items: [{ skillId: 'library:child-review', name: 'child-review', digest: `sha256:${'a'.repeat(64)}` }] };
    let publishEvent: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    let runtimeSessionId = '';
    let sequence = 0;
    const runtime: AgentRuntime = { sessions: { async open(request) {
      runtimeSessionId = request.sessionId;
      expect(request.skills).toEqual(delivery === 'acknowledged' || delivery === 'refused' ? skills : undefined);
      return {
        ...(delivery === 'refused' ? { skillsDelivered: false } : {}),
        watch(listener) { publishEvent = listener; return { dispose() { publishEvent = undefined; } }; },
        async send(input) {
          const emit = (event: unknown) => publishEvent?.(AgentSessionRuntimeEventSchema.parse({
            ...event as object, sequence: ++sequence, sessionId: runtimeSessionId, emittedAtMs: sequence,
          }));
          emit({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
          emit({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
          emit({ kind: 'skill-usage', turnId: input.delivery.turnId, skills: [
            { name: 'happier:child-review' },
            { name: 'child-review', path: '/private/run/skills/child-review/SKILL.md' },
            { name: 'happier:parent-review' },
            { name: 'child-review', path: '/native/child-review/SKILL.md' },
          ] });
          emit({ kind: 'turn-complete', turnId: input.delivery.turnId });
          // A terminal turn no longer supplies evidence authority.
          emit({ kind: 'skill-usage', turnId: input.delivery.turnId, skills: [{ name: 'happier:child-review' }] });
          return { status: 'admitted' as const };
        },
        async dispose() {},
      };
    } } };
    const createSessionContext: NativeAgentSessionContextLeaseFactory = ({ services, signal }) => {
      const lease = createVoiceSessionContextLease({ services, signal, async dispose() {} });
      return { ...lease, context: { ...lease.context, session: { ...lease.context.session, id: 'child-runtime-session' } },
        ...(delivery === 'acknowledged' || delivery === 'refused' ? { skills } : {}),
        ...(delivery === 'index' ? { skillIndex: 'Use skills.read for child-review' } : {}),
        ...(delivery === 'acknowledged' || delivery === 'refused' ? {
          // The current Session Run tool binding supplies this real transcript
          // projection, rather than an account field on the context lease.
          observeSkillUse: async (event: Extract<AgentSessionRuntimeEvent, { kind: 'skill-usage' }>) => {
            const effect = projectRuntimeTranscriptEvent({ session: { sessionId: 'child-runtime-session' },
              event, skillDelivery: skills, usageAccount: account });
            skillObservationEffects.push(effect);
            await effect;
          },
        } : {}),
      };
    };
    const common = { runtime, createSessionContext,
      lease: { pluginId: 'acme.run', pluginVersion: '1.0.0', agentId: 'acme.run/default', localAgentId: 'default',
        occurrenceId: `${kind}-${delivery}`, isCurrent: () => true },
      options: { cwd: '/repo', runId: 'child-run', scope: 'session_owned' as const, backendId: 'acme.run/default',
        permissionMode: 'read_only', start: { intent: 'review' as const, runClass: kind === 'finite' ? 'bounded' as const : 'long_lived' as const,
          retentionPolicy: 'resumable' as const } },
    };
    const host = kind === 'finite' ? createNativeAgentSessionExecutionRunHostRuntime({ ...common, supportsResume: false })
      : createNativeAgentSessionInteractionHostRuntime({ ...common,
        sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: false } });
    const unsubscribeMessages = host.subscribeMessages(message => { messages.push(message); });
    try {
      await host.provisionRuntime();
      await host.deliverInput('child-run', { text: 'Use the child skill' });
      await host.waitForTurnCompletion?.();
      await Promise.all(skillObservationEffects);
      expect(usageBoundary.requests).toEqual(delivery === 'acknowledged'
        ? [{ skillIds: ['library:child-review'], account }] : []);
      expect(messages).not.toContainEqual(expect.objectContaining({ type: 'skill-usage' }));
    } finally { unsubscribeMessages?.(); await host.dispose(); }
  }
});

it.each(['finite', 'retained'] as const)('publishes actual Codex ACP skill refusal for a Session-owned %s Run', async kind => {
  await withTempDir('happier-run-acp-skills-', async directory => {
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'agent.mjs', source: `
      import { createInterface } from 'node:readline';
      const lines = createInterface({ input: process.stdin });
      for await (const line of lines) {
        const request = JSON.parse(line);
        if (request.id === undefined) continue;
        let result = {};
        if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
        if (request.method === 'session/new') result = { sessionId: 'native-session' };
        if (request.method === 'session/load') result = { sessionId: request.params.sessionId };
        if (request.method === 'session/prompt') result = { stopReason: 'end_turn' };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      }
    ` });
    const skills = { pluginRoot: join(directory, 'private-plugin'), skillsRoot: join(directory, 'private-plugin', 'skills'),
      items: [{ skillId: 'child-review', name: 'child-review', digest: 'sha256:review' }], nativeDisables: [] };
    for (const withSkills of [false, true]) {
      const events: unknown[] = [];
      const controller = new AbortController();
      // The managed executable and committed Session event are genuine external boundaries.
      const dependencies: PublicAcpComposerDependencies = {
        pluginId: 'happier.agent.codex', agentId: 'codex', signal: controller.signal, isCurrent: () => true,
        systemTools: { async resolve() { throw new Error('Unexpected system tool resolution'); } },
        managedDependencies: { async resolve(request) {
          expect(request.dependencyId).toBe('codex-acp');
          return { command: process.execPath, args: [script], env: {}, release() {} };
        } },
        interactions: { async request() { throw new Error('Unexpected interaction'); } },
        media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
        models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
      };
      const runtime = await createCodexAgentRuntime({ plugin: { id: 'happier.agent.codex', version: '0.0.0' },
        agent: { id: 'codex' }, signal: controller.signal });
      const createSessionContext: NativeAgentSessionContextLeaseFactory = ({ services, signal }) => {
        const lease = createVoiceSessionContextLease({ services, signal, dispose: async () => undefined });
        const context: AgentSessionRuntimeContext = { ...lease.context, protocols: { ...lease.context.protocols,
          acp: { ...lease.context.protocols.acp,
            open: (request, options) => createPublicAcpSession(request, options, dependencies) },
        } };
        return { ...lease, context, ...(withSkills ? { skills } : {}),
          capabilityNoticeSession: { enqueueSessionEventCommitted: async (event: Parameters<ApiSessionClient['enqueueSessionEventCommitted']>[0]) => {
            events.push(event); return { persisted: true as const, delivered: false as const };
          } },
        };
      };
      const common = {
        runtime, generationSignal: controller.signal,
        lease: { pluginId: 'happier.agent.codex', pluginVersion: '0.0.0', agentId: 'codex', localAgentId: 'codex',
          occurrenceId: `codex-acp-${kind}`, isCurrent: () => true },
        options: { cwd: directory, runId: `child-${kind}`, scope: 'session_owned' as const, backendId: 'codex',
          permissionMode: 'read_only', isolation: { env: { HAPPIER_CODEX_BACKEND_MODE: 'acp' } },
          start: { intent: 'review' as const, runClass: kind === 'finite' ? 'bounded' as const : 'long_lived' as const,
            retentionPolicy: 'resumable' as const } },
        createSessionContext,
      };
      const host = kind === 'finite'
        ? createNativeAgentSessionExecutionRunHostRuntime({ ...common, supportsResume: true })
        : createNativeAgentSessionInteractionHostRuntime({ ...common,
          sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } });
      try {
        await host.provisionRuntime({ initialPrompt: 'Review child workspace' });
        expect(events.map(readSessionCapabilityNoticeV1)).toEqual(withSkills ? [{ v: 1, items: [{
          kind: 'skill', name: 'child-review', itemId: 'child-review', code: 'skills_unavailable', detail: 'launch_path_unsupported',
        }] }] : []);
      } finally { await host.dispose(); controller.abort(); }
    }
  });
});
