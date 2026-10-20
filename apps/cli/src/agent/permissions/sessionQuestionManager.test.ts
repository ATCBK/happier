import { describe, expect, it } from 'vitest';
import { admitManagerQuestionAnswer, resolveInitialQuestionHandler, type QuestionSessionSnapshot } from './sessionQuestionManager';

function corpus() {
    const sessions = new Map<string, QuestionSessionSnapshot>([
        ['worker', { sessionId: 'worker', accountId: 'account', managerSessionId: 'manager', available: true, answersWorkerQuestions: true }],
        ['manager', { sessionId: 'manager', accountId: 'account', managerSessionId: 'lead', available: true, answersWorkerQuestions: true }],
        ['lead', { sessionId: 'lead', accountId: 'account', managerSessionId: null, available: true, answersWorkerQuestions: true }],
    ]);
    // The corpus is the authenticated external Session-read boundary; routing is real.
    return { sessions, readSession: async (id: string) => sessions.get(id) ?? null };
}

describe('question owner manager decision', () => {
    it('offers a routine worker question to its available same-Account manager', async () => {
        const { readSession } = corpus();
        expect(await resolveInitialQuestionHandler({ sessionId: 'worker', lasting: false, readSession }))
            .toEqual({ kind: 'session', sessionId: 'manager' });
        expect(await admitManagerQuestionAnswer({ sessionId: 'worker', callerSessionId: 'manager', accountId: 'account',
            handler: { kind: 'session', sessionId: 'manager' }, question: true, lasting: false, readSession })).toBe(true);
    });

    it.each(['lasting', 'other_account', 'unavailable', 'toggle_off', 'missing'] as const)(
        'sends a %s question to the person at raise time', async (condition) => {
            const { sessions, readSession } = corpus();
            const manager = sessions.get('manager')!;
            if (condition === 'missing') sessions.delete('manager');
            else sessions.set('manager', { ...manager,
                ...(condition === 'other_account' ? { accountId: 'other' } : {}),
                ...(condition === 'unavailable' ? { available: false } : {}),
                ...(condition === 'toggle_off' ? { answersWorkerQuestions: false } : {}),
            });
            expect(await resolveInitialQuestionHandler({ sessionId: 'worker', lasting: condition === 'lasting', readSession }))
                .toEqual({ kind: 'person' });
        },
    );

    it.each(['approval', 'lasting', 'other_account', 'toggle_off', 'sibling', 'worker', 'wrong_handler', 'detached'] as const)(
        'refuses the %s exception at the owner', async (condition) => {
            const { sessions, readSession } = corpus();
            const manager = sessions.get('manager')!;
            if (condition === 'other_account') sessions.set('manager', { ...manager, accountId: 'other' });
            if (condition === 'toggle_off') sessions.set('manager', { ...manager, answersWorkerQuestions: false });
            if (condition === 'detached') sessions.set('worker', { ...sessions.get('worker')!, managerSessionId: null });
            expect(await admitManagerQuestionAnswer({ sessionId: 'worker', accountId: 'account',
                callerSessionId: condition === 'sibling' ? 'sibling' : condition === 'worker' ? 'worker' : 'manager',
                handler: condition === 'wrong_handler' ? { kind: 'person' } : { kind: 'session', sessionId: 'manager' },
                question: condition !== 'approval', lasting: condition === 'lasting', readSession })).toBe(false);
        },
    );

    it('allows the next manager after pass-up only while the live manager chain still binds it', async () => {
        const { sessions, readSession } = corpus();
        const input = { sessionId: 'worker', callerSessionId: 'lead', accountId: 'account',
            handler: { kind: 'session' as const, sessionId: 'lead' }, question: true, lasting: false, readSession };
        expect(await admitManagerQuestionAnswer(input)).toBe(true);
        sessions.set('manager', { ...sessions.get('manager')!, managerSessionId: null });
        expect(await admitManagerQuestionAnswer(input)).toBe(false);
    });
});
