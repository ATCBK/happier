import { projectNativeJsonValueForTransport, type JsonValue } from '../../json/strictJsonValue.js';

export type EntityFilterConditionOperatorV1 = 'is' | 'is_not' | 'before' | 'after' | 'between';
export type EntityFilterConditionV1 = Readonly<{
    operator: EntityFilterConditionOperatorV1;
    values: readonly JsonValue[];
}>;

/** A selection lens, not a matcher or a persisted condition schema. */
export type EntityFilterConditionCodecV1<Selection> = Readonly<{
    operators: readonly EntityFilterConditionOperatorV1[];
    valueOptions: readonly JsonValue[];
    /** A named UI choice expands to these canonical selection values; its key is never stored. */
    valueGroups?: readonly Readonly<{ value: JsonValue; values: readonly JsonValue[] }>[];
    project(selection: Selection): readonly EntityFilterConditionV1[];
    replace(selection: Selection | undefined, condition: EntityFilterConditionV1): Selection;
    remove(selection: Selection, operator: EntityFilterConditionOperatorV1): Selection | undefined;
}>;

function record(value: JsonValue): Readonly<Record<string, JsonValue>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a condition selection object');
    return value as Readonly<Record<string, JsonValue>>;
}

/** Shared shape operations; the field's canonical schema owns value admission. */
export function createEntityFilterConditionCodecV1<Selection>(input: Readonly<{
    encoding: 'value' | 'values' | 'set' | 'time';
    parseValue(value: unknown): Selection;
    valueFromSelection?(selection: Selection): unknown;
    operator?: 'is' | 'is_not';
    valueOptions?(): readonly JsonValue[];
    valueGroups?(): NonNullable<EntityFilterConditionCodecV1<Selection>['valueGroups']>;
}>): EntityFilterConditionCodecV1<Selection> {
    const operator = input.operator ?? 'is';
    const operators: readonly EntityFilterConditionOperatorV1[] = input.encoding === 'set' ? ['is', 'is_not']
        : input.encoding === 'time' ? ['before', 'after', 'between'] : [operator];
    const valueOf = (selection: Selection) => projectNativeJsonValueForTransport(input.valueFromSelection
        ? input.valueFromSelection(selection) : selection);
    return {
        operators,
        get valueOptions() { return input.valueOptions?.() ?? []; },
        get valueGroups() { return input.valueGroups?.() ?? []; },
        project(selection) {
            const value = valueOf(selection);
            if (input.encoding === 'set') {
                const selected = record(value);
                if (!Array.isArray(selected.include) || !Array.isArray(selected.exclude)) throw new TypeError('Invalid set selection');
                return [
                    ...(selected.include.length ? [{ operator: 'is' as const, values: selected.include }] : []),
                    ...(selected.exclude.length ? [{ operator: 'is_not' as const, values: selected.exclude }] : []),
                ];
            }
            if (input.encoding === 'time') {
                const selected = record(value);
                if (selected.op === 'between' && typeof selected.fromMs === 'number' && typeof selected.toMs === 'number') {
                    return [{ operator: 'between', values: [selected.fromMs, selected.toMs] }];
                }
                if ((selected.op === 'before' || selected.op === 'after') && typeof selected.atMs === 'number') {
                    return [{ operator: selected.op, values: [selected.atMs] }];
                }
                throw new TypeError('Invalid time selection');
            }
            if (input.encoding === 'values') {
                if (!Array.isArray(value)) throw new TypeError('Invalid multi-value selection');
                return [{ operator, values: value }];
            }
            return [{ operator, values: [value] }];
        },
        replace(selection, condition) {
            if (!operators.includes(condition.operator)) throw new TypeError('Unsupported condition operator');
            const values = condition.values;
            if (input.encoding === 'set') {
                const previous = selection === undefined ? { include: [], exclude: [] } : record(valueOf(selection));
                return input.parseValue({ ...previous, [condition.operator === 'is' ? 'include' : 'exclude']: values });
            }
            if (input.encoding === 'time') {
                const between = condition.operator === 'between';
                if (values.length !== (between ? 2 : 1)) throw new TypeError('Invalid time condition arity');
                return input.parseValue(between ? { op: 'between', fromMs: values[0], toMs: values[1] }
                    : { op: condition.operator, atMs: values[0] });
            }
            if (input.encoding === 'values') return input.parseValue(values);
            if (values.length !== 1) throw new TypeError('A scalar condition requires one value');
            return input.parseValue(values[0]);
        },
        remove(selection, removedOperator) {
            if (!operators.includes(removedOperator)) throw new TypeError('Unsupported condition operator');
            if (input.encoding !== 'set') return undefined;
            const previous = record(valueOf(selection));
            const value = { ...previous, [removedOperator === 'is' ? 'include' : 'exclude']: [] };
            if (Array.isArray(value.include) && value.include.length === 0 && Array.isArray(value.exclude) && value.exclude.length === 0) return undefined;
            return input.parseValue(value);
        },
    };
}
