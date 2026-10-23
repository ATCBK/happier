import { describe, expect, it } from 'vitest';

import {
    normalizeAskUserQuestionAnswers,
    buildNativeAskUserQuestionAnswersForClaude,
    normalizeNativeAskUserQuestionAnswers,
    normalizeAskUserQuestionInputForPublication,
} from './askUserQuestion.js';

describe('Claude AskUserQuestion permissions helpers', () => {
    it('injects freeform defaults on every question when absent', () => {
        const input = {
            questions: [
                { header: 'A', question: 'pick', multiSelect: false, options: [{ label: 'x' }] },
                { header: 'B', question: 'pick b', multiSelect: true, options: [{ label: 'y' }] },
            ],
        };
        const out = normalizeAskUserQuestionInputForPublication('AskUserQuestion', input);

        expect(out).toEqual({
            questions: [
                { header: 'A', question: 'pick', multiSelect: false, options: [{ label: 'x' }], freeform: {} },
                { header: 'B', question: 'pick b', multiSelect: true, options: [{ label: 'y' }], freeform: {} },
            ],
        });
        expect(input.questions[0]?.freeform).toBeUndefined();
        expect(input.questions[1]?.freeform).toBeUndefined();
    });

    it('preserves existing freeform fields', () => {
        const input = {
            questions: [
                { header: 'A', question: 'pick', multiSelect: false, options: [], freeform: { placeholder: 'custom' } },
            ],
        };

        expect(normalizeAskUserQuestionInputForPublication('AskUserQuestion', input)).toBe(input);
    });

    it('handles the snake_case tool name alias', () => {
        const input = { questions: [{ header: 'H', question: 'Q', multiSelect: false, options: [] }] };

        expect(normalizeAskUserQuestionInputForPublication('ask_user_question', input)).toEqual({
            questions: [{ header: 'H', question: 'Q', multiSelect: false, options: [], freeform: {} }],
        });
    });

    it('leaves unrelated or unsupported inputs unchanged', () => {
        const commandInput = { command: 'ls' };
        const malformedQuestions = { questions: 'bad' };

        expect(normalizeAskUserQuestionInputForPublication('Bash', commandInput)).toBe(commandInput);
        expect(normalizeAskUserQuestionInputForPublication('AskUserQuestion', null)).toBe(null);
        expect(normalizeAskUserQuestionInputForPublication('AskUserQuestion', 'str')).toBe('str');
        expect(normalizeAskUserQuestionInputForPublication('AskUserQuestion', {})).toEqual({});
        expect(normalizeAskUserQuestionInputForPublication('AskUserQuestion', malformedQuestions)).toBe(malformedQuestions);
    });

    it('skips non-object questions while updating valid ones', () => {
        const input = { questions: [null, { header: 'A', question: 'Q', multiSelect: false, options: [] }, 42] };

        expect(normalizeAskUserQuestionInputForPublication('AskUserQuestion', input)).toEqual({
            questions: [null, { header: 'A', question: 'Q', multiSelect: false, options: [], freeform: {} }, 42],
        });
    });

    it('projects canonical single- and multi-select arrays to Claude answer strings', () => {
        expect(normalizeAskUserQuestionAnswers({
            'Question A': ['Answer A'],
            'Question B': ['Answer B1', 'Answer B2'],
            'Legacy scalar': 'Answer C',
            'Invalid number': 123,
            '': ['blank'],
        })).toEqual({
            'Question A': 'Answer A',
            'Question B': 'Answer B1, Answer B2',
        });
        expect(normalizeAskUserQuestionAnswers({})).toBeNull();
        expect(normalizeAskUserQuestionAnswers(null)).toBeNull();
    });
});


describe('native Claude answer projection', () => {
    it('projects semantic choice ids in provider order while preserving literal question keys and custom values', () => {
        const questions = [{
            id: 'native-q', question: '__proto__', header: 'Prototype', multiSelect: true,
            options: [{ id: 'a', label: 'Alpha, beta' }, { id: 'b', label: '雪 🦦' }],
        }];
        const output = buildNativeAskUserQuestionAnswersForClaude(questions, {
            'native-q': ['b', 'custom\nvalue', 'a'],
        });
        expect(Object.entries(output)).toEqual([['__proto__', 'Alpha, beta, 雪 🦦, custom\nvalue']]);
    });
});


describe('observed native Claude answer projection', () => {
    const closed = [{ id: 'native-q', question: 'Pick values', multiSelect: true, freeform: false,
        options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] }];
    it('recovers proven closed multiple-choice arrays through canonical semantic ids', () => {
        expect(normalizeNativeAskUserQuestionAnswers(closed, { 'Pick values': 'Alpha, Beta' }))
            .toEqual({ 'native-q': ['a', 'b'] });
    });
    it('does not guess between a native multi-select join and punctuation in custom text', () => {
        const questions = closed.map(({ freeform: _, ...question }) => question);
        expect(normalizeNativeAskUserQuestionAnswers(questions, { 'Pick values': 'Alpha, Beta' })).toBeNull();
        expect(normalizeNativeAskUserQuestionAnswers(questions, { 'Pick values': 'Coffee, tea\n雪 🦦' }))
            .toEqual({ 'native-q': ['Coffee, tea\n雪 🦦'] });
    });
    it('keeps comma-bearing labels intact and rejects indistinguishable closed choice combinations', () => {
        const questions = [{ ...closed[0], options: [
            { id: 'comma', label: 'Alpha, Beta' }, { id: 'gamma', label: 'Gamma' },
        ] }];
        expect(normalizeNativeAskUserQuestionAnswers(questions, { 'Pick values': 'Alpha, Beta, Gamma' }))
            .toEqual({ 'native-q': ['comma', 'gamma'] });
        expect(normalizeNativeAskUserQuestionAnswers([{ ...closed[0], options: [
            ...closed[0]!.options, { id: 'comma', label: 'Alpha, Beta' },
        ] }], { 'Pick values': 'Alpha, Beta' })).toBeNull();
    });
    it('preserves exact single-choice custom punctuation and rejects incomplete provider evidence', () => {
        const questions = [{ id: 'native-q', question: 'Pick one', options: ['Alpha', 'Beta'] }];
        expect(normalizeNativeAskUserQuestionAnswers(questions, { 'Pick one': 'Coffee, tea\n雪 🦦' }))
            .toEqual({ 'native-q': ['Coffee, tea\n雪 🦦'] });
        expect(normalizeNativeAskUserQuestionAnswers(questions, {})).toBeNull();
        expect(normalizeNativeAskUserQuestionAnswers(questions, { 'Pick one': 'Alpha', extra: 'Beta' })).toBeNull();
    });
});
