import { describe, expect, it } from 'vitest';
import { SessionNeedsYouRaiseInputV1Schema, SessionQuestionContextV1Schema } from './questionV1.js';

const create = { mode: 'wait', type: 'decision', questions: [{ id: 'choice', type: 'text', prompt: 'Which revision?' }] };

describe('Session needs-you question input', () => {
    it('retains the optional explanatory reason on the input and stored question context', () => {
        const reason = 'The API versions disagree';
        expect(SessionNeedsYouRaiseInputV1Schema.safeParse({ ...create, reason })).toMatchObject({ success: true, data: { reason } });
        expect(SessionQuestionContextV1Schema.safeParse({ mode: 'wait', lasting: false, type: 'decision', reason }))
            .toMatchObject({ success: true, data: { reason } });
    });
    it('accepts a wait question, continue with an assumption, and reasoned withdrawal on the same boundary', () => {
        expect(SessionNeedsYouRaiseInputV1Schema.safeParse(create).success).toBe(true);
        expect(SessionNeedsYouRaiseInputV1Schema.safeParse({ ...create, mode: 'continue', assumption: 'Use revision 3', lasting: true }).success).toBe(true);
        expect(SessionNeedsYouRaiseInputV1Schema.safeParse({ requestId: 'request', withdraw: 'No longer needed' }).success).toBe(true);
    });
    it('rejects empty assumptions, approval requests, and fields that impersonate host routing', () => {
        for (const input of [{ ...create, mode: 'continue' }, { ...create, mode: 'continue', assumption: '' },
            { ...create, type: 'approval' }, { ...create, currentHandler: { kind: 'person' } },
            { requestId: 'request', withdraw: '' }]) {
            expect(SessionNeedsYouRaiseInputV1Schema.safeParse(input).success).toBe(false);
        }
    });
    it('reuses the canonical question identifier and form bounds', () => {
        expect(SessionNeedsYouRaiseInputV1Schema.safeParse({ ...create, questions: Array.from({ length: 32 }, (_, i) => ({ ...create.questions[0], id: `q${i}` })) }).success).toBe(true);
        expect(SessionNeedsYouRaiseInputV1Schema.safeParse({ ...create, questions: Array.from({ length: 33 }, (_, i) => ({ ...create.questions[0], id: `q${i}` })) }).success).toBe(false);
        expect(SessionNeedsYouRaiseInputV1Schema.safeParse({ ...create, questions: [create.questions[0], create.questions[0]] }).success).toBe(false);
    });
});
