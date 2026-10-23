import { summarizeAgentRequestQuestions, type AgentRequestQuestionSummary } from '@happier-dev/plugin-sdk/sessions';
import { StructuredQuestionAnswersV1Schema, type StructuredQuestionAnswersV1 } from '@happier-dev/plugin-sdk/sessions';

const ASK_USER_QUESTION_TOOL_NAMES = new Set<string>([
    'AskUserQuestion',
    'ask_user_question',
]);

export function isAskUserQuestionToolName(toolName: string): boolean {
    return ASK_USER_QUESTION_TOOL_NAMES.has(toolName);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function normalizeAskUserQuestionAnswers(value: unknown): Record<string, string> | null {
    if (!isPlainObject(value)) return null;

    const answers = Object.create(null) as Record<string, string>;
    for (const [question, answer] of Object.entries(value)) {
        if (question && isStringArray(answer)) {
            answers[question] = answer.join(', ');
        }
    }

    return Object.keys(answers).length > 0 ? answers : null;
}

export function normalizeAskUserQuestionInputForPublication(toolName: string, toolInput: unknown): unknown {
    if (!isAskUserQuestionToolName(toolName)) return toolInput;
    if (!isPlainObject(toolInput)) return toolInput;

    const questionsRaw = toolInput.questions;
    if (!Array.isArray(questionsRaw)) return toolInput;

    let mutated = false;
    const questions = questionsRaw.map((question) => {
        if (!isPlainObject(question)) return question;
        if ('freeform' in question && typeof question.freeform !== 'undefined') {
            return question;
        }
        mutated = true;
        return { ...question, freeform: {} };
    });

    if (!mutated) return toolInput;

    return { ...toolInput, questions };
}

/** Native Claude emits checkbox labels in provider option order, keyed by provider text. */
export function buildNativeAskUserQuestionAnswersForClaude(
    questions: readonly unknown[],
    answers: StructuredQuestionAnswersV1,
): Readonly<Record<string, string>> {
    const summary = summarizeAgentRequestQuestions(questions);
    const ordered = Object.create(null) as Record<string, readonly string[]>;
    for (const question of summary) {
        const selected = answers[question.answerKey] ?? [];
        ordered[question.question] = [
            ...question.choices.filter((choice) => selected.includes(choice.value)).map((choice) => choice.label),
            ...selected.filter((value) => !question.choices.some((choice) => choice.value === value)),
        ];
    }
    return Object.freeze(normalizeAskUserQuestionAnswers(ordered) ?? {});
}



/** Decode only a unique provider-order join; comma-bearing labels remain indivisible. */
function decodeClosedNativeChoiceAnswers(
    choices: AgentRequestQuestionSummary['choices'],
    value: string,
): readonly string[] | null {
    const states = new Map<number, readonly (readonly string[])[]>([[0, [[]]]]);
    for (const choice of choices) {
        for (const [offset, paths] of [...states]) {
            const prefix = (offset === 0 ? '' : ', ') + choice.label;
            if (!value.startsWith(prefix, offset)) continue;
            const nextOffset = offset + prefix.length;
            // Two distinct paths suffice to establish ambiguity; this does not limit valid answers.
            states.set(nextOffset, [
                ...(states.get(nextOffset) ?? []),
                ...paths.map(path => [...path, choice.value]),
            ].slice(0, 2));
        }
    }
    const paths = states.get(value.length);
    return paths?.length === 1 && paths[0]!.length > 0 ? paths[0]! : null;
}

/**
 * Project observed native scalars only when their canonical array is recoverable.
 * A custom multi-select value may contain the same comma join as selected choices;
 * returning null preserves that uncertainty instead of inventing answer history.
 */
export function normalizeNativeAskUserQuestionAnswers(
    questions: readonly unknown[],
    providerAnswers: unknown,
): StructuredQuestionAnswersV1 | null {
    if (!isPlainObject(providerAnswers)) return null;
    const publication = normalizeAskUserQuestionInputForPublication('AskUserQuestion', { questions });
    const summary = summarizeAgentRequestQuestions(isPlainObject(publication) && Array.isArray(publication.questions) ? publication.questions : []);
    if (!summary.length || summary.length !== questions.length
        || new Set(summary.map(question => question.answerKey)).size !== questions.length
        || new Set(summary.map(question => question.question)).size !== questions.length
        || Object.keys(providerAnswers).length !== questions.length) return null;
    const answers = Object.create(null) as Record<string, readonly string[]>;
    for (const question of summary) {
        const value = Object.hasOwn(providerAnswers, question.question) ? providerAnswers[question.question] : undefined;
        if (typeof value !== 'string' || !value.length) return null;
        if (question.selection === 'multiple' && !question.allowCustom) {
            const selected = decodeClosedNativeChoiceAnswers(question.choices, value);
            if (!selected) return null;
            answers[question.answerKey] = selected;
            continue;
        }
        if (question.selection === 'multiple'
            && question.choices.some(choice => value.startsWith(choice.label + ', '))) return null;
        const matches = question.selection === 'text' ? [] : question.choices.filter(choice => choice.label === value);
        if (matches.length > 1 || (matches.length === 0 && !question.allowCustom)) return null;
        answers[question.answerKey] = [matches[0]?.value ?? value];
    }
    const parsed = StructuredQuestionAnswersV1Schema.safeParse(answers);
    return parsed.success ? parsed.data : null;
}
