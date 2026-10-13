import { expect, it } from 'vitest';
import { createClaudeSkillUsageWitness } from './skillUsage.js';
import fixture from './__fixtures__/skillUsage.v1.json';

it('reports a captured native Skill invocation once and ignores native or unrelated tools', () => {
    const witness = createClaudeSkillUsageWitness();
    witness.observe(fixture.assistant);
    witness.observe(fixture.assistant);
    witness.observe({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Skill', input: { skill: 'native-only' } },
        { type: 'tool_use', name: 'Read', input: { skill: 'happier:unrelated-tool' } },
        { type: 'tool_use', name: 'Skill', input: { skill: 'happier:' } },
        { type: 'tool_use', name: 'Skill', input: { skill: `happier:${'x'.repeat(20_000)}` } },
    ] } });
    expect(witness.finish()).toEqual([{ name: 'happier:contract-skill' }]);
    const nextTurn = createClaudeSkillUsageWitness();
    nextTurn.observe(fixture.assistant);
    expect(nextTurn.finish()).toEqual([{ name: 'happier:contract-skill' }]);
});
