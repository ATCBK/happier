import { describe, expect, it } from 'vitest';

import { resolveBuiltinWorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/builtins/catalog';

import { listWorkflowPersonInputs, resolveWorkflowBuiltinInputPresentation } from './workflowBuiltinInputPresentation';

describe('built-in workflow input presentation', () => {
    it('gives collaboration inputs human-readable labels through the shared presentation owner', () => {
        const inputsByWorkflow = {
            'builtin:fresh-opinions': ['question', 'participants', 'synthesis', 'synthesizer', 'previousRoundContext'],
            'builtin:answer-and-review': ['question', 'answerer', 'reviewer'],
            'builtin:debate': ['question', 'participants', 'rounds', 'digestAuthor', 'previousRoundContext'],
            'builtin:plan-with-a-panel': ['request', 'engines', 'participants', 'previousRoundContext'],
            'builtin:review-and-converge': ['engines', 'maxRounds', 'apply', 'reviewSession'],
        };

        for (const [workflow, inputs] of Object.entries(inputsByWorkflow)) {
            const presentation = resolveWorkflowBuiltinInputPresentation(workflow);
            expect(presentation, workflow).toBeDefined();
            for (const input of inputs) {
                expect(presentation?.[input]?.title, `${workflow}.${input}`).toEqual(expect.any(String));
                expect(presentation?.[input]?.title.trim(), `${workflow}.${input}`).not.toBe('');
                expect(presentation?.[input]?.title, `${workflow}.${input}`).not.toBe(input);
                expect(presentation?.[input]?.title, `${workflow}.${input}`).not.toContain('workflows.builtins.');
            }
        }
    });

    it('keeps authored workflows outside built-in localization', () => {
        expect(resolveWorkflowBuiltinInputPresentation('plugin:example/custom')).toBeUndefined();
        expect(resolveWorkflowBuiltinInputPresentation(null)).toBeUndefined();
    });
    it('never asks a person for an input the Run\'s own trigger binds', () => {
        const inputs = resolveBuiltinWorkflowDefinitionV1('keep-going')!.definition.inputs;
        expect(inputs.map((input) => input.name)).toContain('triggerId');
        expect(listWorkflowPersonInputs('builtin:keep-going', inputs).map((input) => input.name))
            .toEqual(inputs.map((input) => input.name).filter((name) => name !== 'triggerId'));
        const panel = resolveBuiltinWorkflowDefinitionV1('plan-with-a-panel')!.definition.inputs;
        expect(listWorkflowPersonInputs('builtin:plan-with-a-panel', panel)).toEqual(panel);
    });
});
