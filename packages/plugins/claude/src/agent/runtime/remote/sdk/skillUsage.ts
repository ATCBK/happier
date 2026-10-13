import { AgentSessionRuntimeEventSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import type { SDKMessage } from '../../../sdk/types.js';

/** The native SDK stream exposes Skill invocations; terminal launches do not. */
export function createClaudeSkillUsageWitness() {
    const names = new Set<string>();
    return {
        observe(message: SDKMessage): void {
            if (message.type !== 'assistant') return;
            const payload = message.message;
            if (!payload || typeof payload !== 'object' || !('content' in payload) || !Array.isArray(payload.content)) return;
            for (const block of payload.content) {
                if (!block || typeof block !== 'object' || block.type !== 'tool_use' || block.name !== 'Skill') continue;
                const input = block.input;
                if (!input || typeof input !== 'object' || !('skill' in input) || typeof input.skill !== 'string') continue;
                if (input.skill.startsWith('happier:') && input.skill.length > 'happier:'.length) names.add(input.skill);
            }
        },
        finish(): ReadonlyArray<Readonly<{ name: string }>> {
            // The canonical consumer owns name bounds; malformed vendor evidence is never published.
            return [...names].filter(name => AgentSessionRuntimeEventSchema.safeParse({
                kind: 'skill-usage', sequence: 0, sessionId: 'skill-usage-witness', emittedAtMs: 0,
                turnId: 'skill-usage-witness', skills: [{ name }],
            }).success).map(name => ({ name }));
        },
    };
}
