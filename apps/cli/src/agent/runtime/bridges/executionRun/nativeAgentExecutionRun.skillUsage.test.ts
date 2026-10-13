import { expect, it, vi } from 'vitest';
import type { AgentRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { createNativeAgentSessionExecutionRunHostRuntime, createNativeAgentSessionInteractionHostRuntime } from './nativeAgentExecutionRun';
import { createVoiceSessionContextLease } from './testkit/nativeSessionContext';
import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import * as controlClient from '@/daemon/controlClient';

it.each(['finite', 'retained'] as const)('records delivered skill use from a %s Session-owned Run through the host projection', async mode => {
    const recorded = vi.spyOn(controlClient, 'recordDaemonSkillUse').mockResolvedValue();
    const skills = { pluginRoot: '/private/run', skillsRoot: '/private/run/skills', nativeDisables: [],
        items: [{ name: 'guide', skillId: 'library-guide', digest: `sha256:${'a'.repeat(64)}` }] };
    const account = { accountId: 'parent-account', serverHttpBaseUrl: 'https://home.example.test' };
    let publish: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    const runtime: AgentRuntime = { sessions: { async open() { return {
        send: async () => ({ status: 'admitted' as const }),
        cancel: async () => ({ status: 'notRunning' as const }),
        watch(listener) { publish = listener; return { dispose() { publish = undefined; } }; },
        dispose: async () => {},
    }; } } };
    const common = {
        runtime,
        lease: { pluginId: 'acme.skills', pluginVersion: '1.0.0', agentId: 'acme.skills/default',
            localAgentId: 'default', occurrenceId: 'skill-usage-run', isCurrent: () => true },
        options: { cwd: '/repo', runId: 'usage-run', scope: 'session_owned' as const,
            backendId: 'acme.skills/default', permissionMode: 'read_only' as const,
            start: { intent: 'review' as const, runClass: 'bounded' as const, retentionPolicy: 'ephemeral' as const } },
        supportsResume: false,
        createSessionContext: ({ services, signal }: Parameters<import('./nativeAgentExecutionRun').NativeAgentSessionContextLeaseFactory>[0]) => ({
            ...createVoiceSessionContextLease({ services, signal, async dispose() {} }), skills,
            observeSkillUse: async (event: Extract<AgentSessionRuntimeEvent, { kind: 'skill-usage' }>) => {
                await projectRuntimeTranscriptEvent({ session: { sessionId: 'session-parent' },
                    event, skillDelivery: skills, usageAccount: account });
            },
        }),
    };
    const host = mode === 'finite' ? createNativeAgentSessionExecutionRunHostRuntime(common)
        : createNativeAgentSessionInteractionHostRuntime({ ...common,
            sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: true } });
    try {
        await host.provisionRuntime({ initialPrompt: 'Use the guide' });
        const event = AgentSessionRuntimeEventSchema.parse({ kind: 'skill-usage', sequence: 2,
            sessionId: 'session-parent', emittedAtMs: 1, turnId: mode === 'finite' ? 'usage-run-turn-1' : 'retained-turn',
            skills: [{ name: 'guide', path: '/private/run/skills/guide/SKILL.md' }] });
        publish?.(event);
        await vi.waitFor(() => expect(recorded).toHaveBeenCalledWith({ skillIds: ['library-guide'], account }));
        publish?.({ ...event, sequence: 3, skills: [{ name: 'guide', path: '/native/guide/SKILL.md' }] });
        expect(recorded).toHaveBeenCalledTimes(1);
    } finally {
        await host.dispose(); recorded.mockRestore();
    }
});
