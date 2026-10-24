import type {
    InteractionTransientQuestionAnswerV1,
    InteractionTransientQuestionV1,
} from '@happier-dev/protocol/plugins/interactions/transientV1';
import { buildAgentRequestSemanticSummary } from '@happier-dev/protocol/activity/agentRequestSummary';
import { StructuredQuestionAnswersV1Schema, type StructuredQuestionAnswersV1 } from '@happier-dev/protocol/tools/structuredQuestionAnswersV1';

export type QuestionAnswerWireValue = string | readonly string[];
type QuestionAnswersWire = Readonly<Record<string, QuestionAnswerWireValue>>;

function resolveChoiceSelection(
    raw: string,
    question: Extract<InteractionTransientQuestionV1, { type: 'singleChoice' | 'multipleChoice' }>,
) {
    const value = raw.trim();
    const byId = question.choices.find((choice) => choice.id === value);
    if (byId) return Object.freeze({ kind: 'choice', choiceId: byId.id });
    const byLabel = question.choices.filter((choice) => choice.label === value);
    if (byLabel.length === 1) return Object.freeze({ kind: 'choice', choiceId: byLabel[0]!.id });
    if (byLabel.length > 1) return null;
    return question.allowCustom && value.length > 0
        ? Object.freeze({ kind: 'custom', value })
        : null;
}

/** One form-answer owner for native interactions and persisted question responses. */
export function normalizeQuestionAnswers(
    questions: readonly InteractionTransientQuestionV1[],
    rawAnswers: QuestionAnswersWire,
): Readonly<Record<string, InteractionTransientQuestionAnswerV1>> | null {
    const byId = new Map(questions.map((question) => [question.id, question]));
    if (byId.size !== questions.length) return null;
    if (Object.keys(rawAnswers).some((questionId) => !byId.has(questionId))) return null;
    const output = Object.create(null) as Record<string, InteractionTransientQuestionAnswerV1>;
    for (const question of questions) {
        const rawAnswer = rawAnswers[question.id];
        if (rawAnswer === undefined) {
            if (question.required) return null;
            continue;
        }
        const values = typeof rawAnswer === 'string' ? [rawAnswer] : rawAnswer;
        if (question.type === 'text') {
            if (values.length !== 1) return null;
            output[question.id] = Object.freeze({ kind: 'text', value: values[0]! });
            continue;
        }
        if (question.type === 'singleChoice') {
            if (values.length !== 1) return null;
            const answer = resolveChoiceSelection(values[0]!, question);
            if (!answer) return null;
            output[question.id] = Object.freeze({ kind: 'singleChoice', answer });
            continue;
        }
        const choices = values.map((value) => resolveChoiceSelection(value, question));
        if (choices.length === 0 || choices.some((choice) => choice === null)) return null;
        const dedupeKeys = choices.map((choice) => choice!.kind === 'choice'
            ? `choice:${choice!.choiceId}`
            : `custom:${choice!.value}`);
        if (new Set(dedupeKeys).size !== dedupeKeys.length) return null;
        output[question.id] = Object.freeze({
            kind: 'multipleChoice',
            answers: choices as [NonNullable<typeof choices[number]>, ...NonNullable<typeof choices[number]>[]],
        });
    }
    return Object.freeze(output);
}

/** Adapt the incumbent persisted/legacy form to the same native answer owner. */
export function normalizeStructuredQuestionPermissionAnswers(input: Readonly<{
    toolName: string;
    toolInput: unknown;
    answers: QuestionAnswersWire;
}>): StructuredQuestionAnswersV1 | null {
    const questions = readStructuredQuestionPermissionQuestions(input);
    if (questions.length === 0) return null;
    const normalized = normalizeQuestionAnswers(questions, input.answers);
    if (!normalized) return null;
    const answers = Object.fromEntries(Object.entries(normalized).map(([id, answer]) => [id,
        answer.kind === 'text' ? [answer.value]
            : answer.kind === 'singleChoice' ? [answer.answer.kind === 'choice' ? answer.answer.choiceId : answer.answer.value]
            : answer.answers.map((selection) => selection.kind === 'choice' ? selection.choiceId : selection.value),
    ]));
    const parsed = StructuredQuestionAnswersV1Schema.safeParse(answers);
    return parsed.success ? parsed.data : null;
}

/** The same normalized form drives answers and the manager's question offer. */
export function readStructuredQuestionPermissionQuestions(input: Readonly<{
    toolName: string;
    toolInput: unknown;
}>): InteractionTransientQuestionV1[] {
    const semantic = buildAgentRequestSemanticSummary({ kind: 'user_action', toolName: input.toolName, toolInput: input.toolInput });
    return semantic.questions.map((question) => {
        const common = { id: question.answerKey, prompt: question.question, required: question.required };
        return question.selection === 'text' || (question.selection === 'single' && question.choices.length === 0)
            ? { ...common, type: 'text' }
            : { ...common, type: question.selection === 'multiple' ? 'multipleChoice' : 'singleChoice',
                allowCustom: question.allowCustom,
                choices: question.choices.map((choice) => ({ id: choice.value, label: choice.label,
                    ...(choice.description ? { description: choice.description } : {}) })) };
    });
}
