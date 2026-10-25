import {
    ElicitRequestFormParamsSchema,
    type ElicitRequestFormParams,
} from '@modelcontextprotocol/sdk/types.js';
import type { ElicitationSchema } from '@agentclientprotocol/sdk';

import { PluginError } from '@happier-dev/plugin-sdk';
import {
    MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1,
    MAX_INTERACTION_TRANSIENT_TITLE_OR_LABEL_CODE_POINTS_V1,
    type InteractionTransientAuthorQuestionV1,
    type InteractionTransientAuthorRequestV1,
    type InteractionTransientQuestionAnswerV1,
} from '@happier-dev/protocol/plugins/interactions/transientV1';

type McpElicitationChoice = Readonly<{
    id: string;
    label?: string;
    description?: string;
}>;

export type McpElicitationFormSchema = ElicitRequestFormParams['requestedSchema'];
export type McpElicitationFormContentValue = string | number | boolean | string[];

function clampToMaxCodePoints(value: string, maxCodePoints: number): string {
    const codePoints = Array.from(value);
    if (codePoints.length <= maxCodePoints) return value;
    const marker = '\n\n... [truncated]';
    const markerPoints = Array.from(marker);
    if (maxCodePoints > markerPoints.length) {
        return `${codePoints.slice(0, maxCodePoints - markerPoints.length).join('')}${marker}`;
    }
    return codePoints.slice(0, maxCodePoints).join('');
}

function invalidForm(message: string): PluginError {
    return new PluginError({ code: 'plugin_mcp_elicitation_invalid', message });
}

function mergeChoiceDescriptions(
    parsedChoices: unknown,
    rawChoices: unknown,
): unknown {
    if (!Array.isArray(parsedChoices) || !Array.isArray(rawChoices)) return parsedChoices;
    return parsedChoices.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        const rawEntry = rawChoices[index];
        if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return entry;
        const description = (rawEntry as { description?: unknown }).description;
        if (typeof description !== 'string' || description.trim().length === 0) return entry;
        return {
            ...(entry as Record<string, unknown>),
            description,
        };
    });
}

export function parseMcpElicitationFormSchema(value: unknown): McpElicitationFormSchema {
    const parsed = ElicitRequestFormParamsSchema.safeParse({
        mode: 'form',
        message: 'MCP elicitation',
        requestedSchema: value,
    });
    if (!parsed.success) throw invalidForm('MCP elicitation schema is invalid');
    const rawProperties =
        value && typeof value === 'object' && !Array.isArray(value)
            ? (value as { properties?: unknown }).properties
            : undefined;
    if (!rawProperties || typeof rawProperties !== 'object' || Array.isArray(rawProperties)) {
        return parsed.data.requestedSchema;
    }
    const mergedProperties: Record<string, unknown> = {
        ...parsed.data.requestedSchema.properties,
    };
    for (const [key, parsedProp] of Object.entries(mergedProperties)) {
        if (!parsedProp || typeof parsedProp !== 'object' || Array.isArray(parsedProp)) continue;
        const rawProp = (rawProperties as Record<string, unknown>)[key];
        if (!rawProp || typeof rawProp !== 'object' || Array.isArray(rawProp)) continue;
        const propRecord = { ...(parsedProp as Record<string, unknown>) };
        if ('oneOf' in propRecord && 'oneOf' in (rawProp as Record<string, unknown>)) {
            propRecord.oneOf = mergeChoiceDescriptions(
                propRecord.oneOf,
                (rawProp as Record<string, unknown>).oneOf,
            );
        }
        if (
            propRecord.items
            && typeof propRecord.items === 'object'
            && !Array.isArray(propRecord.items)
            && (rawProp as Record<string, unknown>).items
            && typeof (rawProp as Record<string, unknown>).items === 'object'
            && !Array.isArray((rawProp as Record<string, unknown>).items)
        ) {
            const parsedItems = { ...(propRecord.items as Record<string, unknown>) };
            const rawItems = (rawProp as { items: Record<string, unknown> }).items;
            if ('anyOf' in parsedItems && 'anyOf' in rawItems) {
                parsedItems.anyOf = mergeChoiceDescriptions(parsedItems.anyOf, rawItems.anyOf);
            }
            if ('oneOf' in parsedItems && 'oneOf' in rawItems) {
                parsedItems.oneOf = mergeChoiceDescriptions(parsedItems.oneOf, rawItems.oneOf);
            }
            propRecord.items = parsedItems;
        }
        mergedProperties[key] = propRecord;
    }
    return {
        ...parsed.data.requestedSchema,
        properties: mergedProperties as McpElicitationFormSchema['properties'],
    };
}

export function parseAcpElicitationFormSchema(schema: ElicitationSchema): McpElicitationFormSchema {
    // ACP 1.2.1 uses null for absent optional schema fields; MCP 1.25.3 uses
    // undefined. Keep that protocol translation separate from MCP validation.
    const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([id, property]) => [
        id,
        Object.fromEntries(Object.entries(property).filter(([key, value]) => (
            value !== null || key === 'type' || key === 'items'
        ))),
    ]));
    return parseMcpElicitationFormSchema({
        type: schema.type ?? 'object',
        properties,
        ...(schema.required == null ? {} : { required: schema.required }),
    });
}

function choicesForProperty(property: Readonly<Record<string, unknown>>): readonly McpElicitationChoice[] {
    if (Array.isArray(property.enum)) {
        const values = property.enum.filter((value): value is string => typeof value === 'string');
        const labels = Array.isArray(property.enumNames)
            ? property.enumNames.filter((value): value is string => typeof value === 'string')
            : [];
        return values.map((value, index) => {
            const rawLabel = labels[index] ?? value;
            return Object.freeze({
                id: value,
                label: clampToMaxCodePoints(rawLabel, MAX_INTERACTION_TRANSIENT_TITLE_OR_LABEL_CODE_POINTS_V1),
            });
        });
    }
    if (Array.isArray(property.oneOf)) {
        return property.oneOf.flatMap((value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
            const item = value as Readonly<Record<string, unknown>>;
            if (typeof item.const !== 'string') return [];
            const description =
                typeof item.description === 'string' && item.description.trim().length > 0
                    ? clampToMaxCodePoints(item.description.trim(), MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1)
                    : undefined;
            const rawLabel = typeof item.title === 'string' ? item.title : item.const;
            return [Object.freeze({
                id: item.const,
                label: clampToMaxCodePoints(rawLabel, MAX_INTERACTION_TRANSIENT_TITLE_OR_LABEL_CODE_POINTS_V1),
                ...(description ? { description } : {}),
            })];
        });
    }
    return [];
}

function arrayItemChoices(property: Readonly<Record<string, unknown>>): readonly McpElicitationChoice[] {
    if (!property.items || typeof property.items !== 'object' || Array.isArray(property.items)) return [];
    const items = property.items as Readonly<Record<string, unknown>>;
    if (Array.isArray(items.anyOf)) {
        return items.anyOf.flatMap((value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
            const item = value as Readonly<Record<string, unknown>>;
            if (typeof item.const !== 'string') return [];
            const description =
                typeof item.description === 'string' && item.description.trim().length > 0
                    ? clampToMaxCodePoints(item.description.trim(), MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1)
                    : undefined;
            const rawLabel = typeof item.title === 'string' ? item.title : item.const;
            return [Object.freeze({
                id: item.const,
                label: clampToMaxCodePoints(rawLabel, MAX_INTERACTION_TRANSIENT_TITLE_OR_LABEL_CODE_POINTS_V1),
                ...(description ? { description } : {}),
            })];
        });
    }
    return choicesForProperty(items);
}

function nonEmptyChoices(
    choices: readonly McpElicitationChoice[],
): [McpElicitationChoice, ...McpElicitationChoice[]] {
    if (choices.length === 0) throw invalidForm('MCP elicitation selection has no choices');
    return [...choices] as [McpElicitationChoice, ...McpElicitationChoice[]];
}

function isChoiceProperty(property: Readonly<Record<string, unknown>>): boolean {
    if (property.type === 'array') {
        return arrayItemChoices(property).length > 0;
    }
    if (property.type === 'boolean') return false;
    return choicesForProperty(property).length > 0;
}

function findCompanionOtherChoiceId(
    property: Readonly<Record<string, unknown>>,
    companionOther: Readonly<Record<string, unknown>>,
): string | null {
    const choices = property.type === 'array'
        ? arrayItemChoices(property)
        : choicesForProperty(property);
    if (choices.length === 0) return null;

    const companionTitle = typeof companionOther.title === 'string'
        ? companionOther.title.trim().toLowerCase()
        : '';
    if (companionTitle.length === 0) return null;
    const matches = choices.filter((choice) => (
        choice.id.toLowerCase() === companionTitle
        || choice.label?.toLowerCase() === companionTitle
    ));
    return matches.length === 1 ? matches[0]!.id : null;
}

function readCompanionOtherProperty(
    properties: Readonly<Record<string, unknown>>,
    id: string,
    property: Readonly<Record<string, unknown>>,
    required: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | null {
    if (id.endsWith('__other') || !isChoiceProperty(property)) return null;
    if (required.has(`${id}__other`)) return null;
    const candidate = properties[`${id}__other`];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const record = candidate as Readonly<Record<string, unknown>>;
    if (record.type !== 'string' || choicesForProperty(record).length > 0) return null;

    // If the base property is required in the schema, collapsing it into allowCustom
    // requires a matching choice ID to assign to content[id] on custom answers.
    // Without one, omitting content[id] would violate the schema's required list.
    const companionOtherChoiceId = findCompanionOtherChoiceId(property, record);
    if (required.has(id) && companionOtherChoiceId === null) {
        return null;
    }

    return record;
}

function isCompanionOtherKey(
    properties: Readonly<Record<string, unknown>>,
    key: string,
    required: ReadonlySet<string>,
): boolean {
    if (!key.endsWith('__other')) return false;
    const baseId = key.slice(0, -'__other'.length);
    const baseProperty = properties[baseId];
    if (!baseProperty || typeof baseProperty !== 'object' || Array.isArray(baseProperty)) return false;
    return readCompanionOtherProperty(properties, baseId, baseProperty as Readonly<Record<string, unknown>>, required) !== null;
}

function propertyPrompt(property: Readonly<Record<string, unknown>>): string | undefined {
    return typeof property.title === 'string' && property.title.trim().length > 0
        ? property.title.trim()
        : typeof property.description === 'string' && property.description.trim().length > 0
            ? property.description.trim()
            : undefined;
}

export function mcpElicitationFormQuestions(
    schema: McpElicitationFormSchema,
): readonly [InteractionTransientAuthorQuestionV1, ...InteractionTransientAuthorQuestionV1[]] | null {
    const required = new Set(schema.required ?? []);
    const properties = schema.properties as Readonly<Record<string, unknown>>;
    const primaryEntries = Object.entries(properties).filter(
        ([id]) => !isCompanionOtherKey(properties, id, required),
    );
    const questions = primaryEntries.map(([id, rawProperty]): InteractionTransientAuthorQuestionV1 => {
        const property = rawProperty as Readonly<Record<string, unknown>>;
        const rawPrompt = propertyPrompt(property);

        const boundedPrompt = clampToMaxCodePoints(rawPrompt ?? id, MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1);

        const companionOther = readCompanionOtherProperty(properties, id, property, required);
        const companionOtherChoiceId = companionOther
            ? findCompanionOtherChoiceId(property, companionOther)
            : null;

        if (property.type === 'array') {
            const rawChoices = arrayItemChoices(property);
            const filteredChoices =
                companionOtherChoiceId && rawChoices.length > 1
                    ? rawChoices.filter((choice) => choice.id !== companionOtherChoiceId)
                    : rawChoices;
            return Object.freeze({
                id,
                prompt: boundedPrompt,
                type: 'multipleChoice' as const,
                required: required.has(id),
                ...(companionOther ? { allowCustom: true } : {}),
                choices: nonEmptyChoices(filteredChoices.length > 0 ? filteredChoices : rawChoices),
            });
        }
        if (property.type === 'boolean') {
            return Object.freeze({
                id,
                prompt: boundedPrompt,
                type: 'singleChoice' as const,
                required: required.has(id),
                choices: nonEmptyChoices(Object.freeze([
                    Object.freeze({ id: 'true', label: 'true' }),
                    Object.freeze({ id: 'false', label: 'false' }),
                ])),
            });
        }
        const rawChoices = choicesForProperty(property);
        if (rawChoices.length > 0) {
            const filteredChoices =
                companionOtherChoiceId && rawChoices.length > 1
                    ? rawChoices.filter((choice) => choice.id !== companionOtherChoiceId)
                    : rawChoices;
            return Object.freeze({
                id,
                prompt: boundedPrompt,
                type: 'singleChoice' as const,
                required: required.has(id),
                ...(companionOther ? { allowCustom: true } : {}),
                choices: nonEmptyChoices(filteredChoices.length > 0 ? filteredChoices : rawChoices),
            });
        }
        const initialValue =
            typeof property.default === 'string' && property.default.length > 0
                ? clampToMaxCodePoints(property.default, MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1)
                : undefined;
        return Object.freeze({
            id,
            prompt: boundedPrompt,
            type: 'text' as const,
            required: required.has(id),
            ...(initialValue ? { initialValue } : {}),
        });
    });
    return questions.length === 0
        ? null
        : questions as [InteractionTransientAuthorQuestionV1, ...InteractionTransientAuthorQuestionV1[]];
}

export function mcpElicitationFormRequest(
    schema: McpElicitationFormSchema,
    message: string,
): Extract<InteractionTransientAuthorRequestV1, { kind: 'questions' | 'confirmation' }> {
    const questions = mcpElicitationFormQuestions(schema);
    const context = message.trim();
    if (questions === null) {
        return {
            kind: 'confirmation',
            title: 'Confirmation',
            message: clampToMaxCodePoints(context || 'Confirmation', MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1),
        };
    }
    if (!context || questions.some((question) => question.prompt.includes(context))) {
        return { kind: 'questions', questions: [...questions] };
    }
    const first = questions[0];
    const property = schema.properties[first.id] as Readonly<Record<string, unknown>>;
    const hasQuestionPrompt = propertyPrompt(property) !== undefined;
    if (questions.length === 1 && !hasQuestionPrompt) {
        return {
            kind: 'questions',
            questions: [{ ...first, prompt: clampToMaxCodePoints(context, MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1) }],
        };
    }
    if (Array.from(context).length <= MAX_INTERACTION_TRANSIENT_TITLE_OR_LABEL_CODE_POINTS_V1) {
        return { kind: 'questions', title: context, questions: [...questions] };
    }
    return {
        kind: 'questions',
        questions: [
            {
                ...first,
                prompt: clampToMaxCodePoints(`${first.prompt}\n\n${context}`, MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1),
            },
            ...questions.slice(1),
        ],
    };
}

function selectedValue(answer: InteractionTransientQuestionAnswerV1): string {
    if (answer.kind === 'text') return answer.value;
    if (answer.kind === 'singleChoice') {
        return answer.answer.kind === 'choice' ? answer.answer.choiceId : answer.answer.value;
    }
    throw invalidForm('MCP elicitation answer is not scalar');
}

function answerValue(
    answer: InteractionTransientQuestionAnswerV1,
    property: Readonly<Record<string, unknown>>,
): McpElicitationFormContentValue {
    if (property.type === 'array') {
        if (answer.kind !== 'multipleChoice') throw invalidForm('MCP elicitation answer is not a list');
        return answer.answers.map((entry) => entry.kind === 'choice' ? entry.choiceId : entry.value);
    }
    const value = selectedValue(answer);
    if (property.type === 'number' || property.type === 'integer') {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || (property.type === 'integer' && !Number.isInteger(parsed))) {
            throw invalidForm('MCP elicitation answer is not a valid number');
        }
        return parsed;
    }
    if (property.type === 'boolean') {
        if (value !== 'true' && value !== 'false') {
            throw invalidForm('MCP elicitation answer is not a valid boolean');
        }
        return value === 'true';
    }
    return value;
}

export function mcpElicitationFormContent(
    schema: McpElicitationFormSchema,
    answers: Readonly<Record<string, InteractionTransientQuestionAnswerV1>>,
): Readonly<Record<string, McpElicitationFormContentValue>> {
    const required = new Set(schema.required ?? []);
    const properties = schema.properties as Readonly<Record<string, unknown>>;
    const content = Object.create(null) as Record<string, McpElicitationFormContentValue>;
    for (const [id, answer] of Object.entries(answers)) {
        const rawProperty = properties[id];
        if (!rawProperty || typeof rawProperty !== 'object' || Array.isArray(rawProperty)) continue;
        if (isCompanionOtherKey(properties, id, required)) continue;
        const property = rawProperty as Readonly<Record<string, unknown>>;
        const companionOther = readCompanionOtherProperty(properties, id, property, required);
        const companionOtherChoiceId = companionOther
            ? findCompanionOtherChoiceId(property, companionOther)
            : null;

        if (companionOther && property.type === 'array' && answer.kind === 'multipleChoice') {
            const choiceIds = answer.answers
                .filter((entry): entry is Extract<typeof entry, { kind: 'choice' }> => entry.kind === 'choice')
                .map((entry) => entry.choiceId);
            const customValues = answer.answers
                .filter((entry): entry is Extract<typeof entry, { kind: 'custom' }> => entry.kind === 'custom')
                .map((entry) => entry.value.trim())
                .filter((value) => value.length > 0);
            if (companionOtherChoiceId && customValues.length > 0 && !choiceIds.includes(companionOtherChoiceId)) {
                choiceIds.push(companionOtherChoiceId);
            }
            content[id] = choiceIds;
            if (customValues.length > 0) {
                content[`${id}__other`] = customValues.join(', ');
            }
            continue;
        }

        if (companionOther && answer.kind === 'singleChoice' && answer.answer.kind === 'custom') {
            if (companionOtherChoiceId) {
                content[id] = companionOtherChoiceId;
            }
            content[`${id}__other`] = answer.answer.value;
            continue;
        }

        content[id] = answerValue(answer, property);
    }
    return Object.freeze(content);
}
