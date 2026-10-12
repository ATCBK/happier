import { describe, expect, it } from 'vitest';
import { projectExecutionRunChildChoiceV1 } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { readExecutionRunChildChoice } from './executionRunChildChoice';

describe('child choice permission for a fresh launch', () => {
    it('revokes the previous no-effect choice after an unknown-effect attempt', () => {
        const refusal = { ok: false as const, error: 'Choose', errorCode: 'execution_run_child_choice_required',
            details: { childChoice: projectExecutionRunChildChoiceV1({ agentTargetKey: 'agent:codex' }),
                executionRunStart: { v: 1, runCreation: 'noRunCreated' } } };
        const choice = readExecutionRunChildChoice(refusal);
        expect(choice).toEqual(refusal.details.childChoice);
        expect(readExecutionRunChildChoice({ ...refusal, details: {
            ...refusal.details, executionRunStart: { v: 1, runCreation: 'outcomeUnknown' },
        } })).toBeNull();
        expect(readExecutionRunChildChoice({ ok: false, error: 'Lost transport', errorCode: 'action_failed' })).toBeNull();
    });
});
