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
        items: [{ name: 'guide', skillId: 'library-guide', digest: `sha256:${'a'.repeat(64)}`, directory: '/private/run/skills/guide' }] };
    const account = { accountId: 'parent-account', serverHttpBaseUrl: 'https://home.example.test' };
    let publish: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    let admittedTurnId: string | undefined;
    let sequence = 0;
    const runtime: AgentRuntime = { sessions: { async open() { return {
        send: async request => {
            admittedTurnId = request.delivery.turnId;
            publish?.({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery,
                sequence: ++sequence, sessionId: 'session-parent', emittedAtMs: sequence });
            publish?.({ kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host',
                sequence: ++sequence, sessionId: 'session-parent', emittedAtMs: sequence });
            return { status: 'admitted' as const };
        },
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
        if (!admittedTurnId) throw new Error('Expected an admitted native turn');
        const event = AgentSessionRuntimeEventSchema.parse({ kind: 'skill-usage', sequence: ++sequence,
            sessionId: 'session-parent', emittedAtMs: sequence, turnId: admittedTurnId,
            skills: [{ name: 'guide', path: '/private/run/skills/guide/SKILL.md' }] });
        if (event.kind !== 'skill-usage') throw new Error('Expected skill usage fixture');
        publish?.(event);
        await vi.waitFor(() => expect(recorded).toHaveBeenCalledWith({ skillIds: ['library-guide'], account }));
        publish?.({ ...event, sequence: ++sequence, skills: [{ name: 'guide', path: '/native/guide/SKILL.md' }] });
        expect(recorded).toHaveBeenCalledTimes(1);
    } finally {
        await host.dispose(); recorded.mockRestore();
    }
});
