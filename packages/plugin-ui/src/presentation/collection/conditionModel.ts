import type {
    EntityFilterEvaluatorV1, EntityFilterFieldKindV1, EntityFilterRegistryV1, EntityFilterConditionOperatorV1,
} from '@happier-dev/plugin-sdk/ui';
import type { JsonValue } from '@happier-dev/plugin-sdk';

export type CollectionConditionValueOption = Readonly<{
    /** Choice identity. For a group, apply `values`, never this presentation key. */
    value: JsonValue;
    /** Absent for a single value; a grouped choice selects this entire vector. */
    values?: readonly JsonValue[];
    label?: string;
    disabled?: boolean;
}>;
export type CollectionConditionBindings = Readonly<{
    evaluator?: EntityFilterEvaluatorV1;
    fields?: Readonly<Record<string, Readonly<{ label?: string; valueOptions?: readonly CollectionConditionValueOption[] }>>>;
}>;
export type CollectionConditionField = Readonly<{
    id: string;
    label: string;
    kind: EntityFilterFieldKindV1;
    operators: readonly EntityFilterConditionOperatorV1[];
    valueOptions: readonly CollectionConditionValueOption[];
}>;
export type CollectionCondition = Readonly<{
    fieldId: string;
    operator: EntityFilterConditionOperatorV1;
    values: readonly JsonValue[];
}>;
export type CollectionConditionRow = Readonly<{
    id: string;
    fieldId: string;
    field: CollectionConditionField;
    operator: EntityFilterConditionOperatorV1 | 'unavailable';
    values: readonly JsonValue[];
    available: boolean;
}>;
export type CollectionConditionModel = Readonly<{
    rows: readonly CollectionConditionRow[];
    availableFields: readonly CollectionConditionField[];
}>;
export type CollectionConditionEdit =
    | Readonly<{ type: 'add'; condition: CollectionCondition }>
    | Readonly<{ type: 'change'; rowId: string; condition: CollectionCondition }>
    | Readonly<{ type: 'remove'; rowId: string }>
    | Readonly<{ type: 'clear' }>;

/** Derived only from a field/operator pair; never a persisted row identity. */
const rowId = (fieldId: string, operator: CollectionConditionRow['operator']) => JSON.stringify([fieldId, operator]);

/** Pure editor projection. Labels/options bind semantic ids; they never decide field support. */
export function conditionModelFromFilter<Filter, Facts>(
    registry: EntityFilterRegistryV1<Filter, Facts>, filter: Filter, bindings: CollectionConditionBindings = {},
): CollectionConditionModel {
    const rows: CollectionConditionRow[] = [];
    const availableFields: CollectionConditionField[] = [];
    for (const descriptor of registry) {
        const presentation = bindings.fields?.[descriptor.id];
        const groups = descriptor.conditions?.valueGroups ?? [];
        const valueOptions = presentation?.valueOptions ?? (groups.length
            ? groups : descriptor.conditions?.valueOptions.map(value => ({ value })) ?? []);
        const field: CollectionConditionField = {
            id: descriptor.id, label: presentation?.label ?? descriptor.id, kind: descriptor.kind,
            operators: descriptor.conditions?.operators ?? [],
            valueOptions: groups.length ? valueOptions.map(option => {
                const group = groups.find(candidate => JSON.stringify(candidate.value) === JSON.stringify(option.value));
                // Presentation may label/disable a group, but its selection vector remains registry-owned.
                return group ? { ...option, values: group.values } : option;
            }) : valueOptions,
        };
        const available = Boolean(descriptor.conditions && descriptor.evaluators.includes(bindings.evaluator ?? 'list'));
        if (available) availableFields.push(field);
        if (!descriptor.isActive(filter)) continue;
        // Stored future selections must stay visible. Only the owner can admit their values.
        let conditions: ReturnType<NonNullable<typeof descriptor.conditions>['project']> | undefined = undefined;
        try { conditions = descriptor.conditions?.project(filter); } catch { conditions = undefined; }
        if (!conditions?.length) {
            rows.push({ id: rowId(field.id, 'unavailable'), fieldId: field.id, field,
                operator: 'unavailable', values: [], available: false });
        } else for (const condition of conditions) rows.push({ ...condition,
            id: rowId(field.id, condition.operator), fieldId: field.id, field, available });
    }
    return { rows, availableFields };
}

/** Applies an explicit editor intent through the same typed selection owner. Input is never mutated. */
export function applyCollectionConditionEdit<Filter, Facts>(
    registry: EntityFilterRegistryV1<Filter, Facts>, filter: Filter, edit: CollectionConditionEdit,
    options: Pick<CollectionConditionBindings, 'evaluator'> = {},
): Filter {
    if (edit.type === 'clear') {
        // Clear is explicit, including opaque narrowing; unrelated edits never remove it.
        return registry.reduce((current, field) => field.clearSelection?.(current) ?? current, filter);
    }
    const model = conditionModelFromFilter(registry, filter, options);
    let next = filter;
    if (edit.type === 'remove' || edit.type === 'change') {
        const row = model.rows.find(candidate => candidate.id === edit.rowId);
        const owner = registry.find(candidate => candidate.id === row?.fieldId);
        if (!row || !owner) throw new TypeError('Condition row is no longer present');
        if (row.operator === 'unavailable') {
            if (!owner.clearSelection) throw new TypeError('Condition cannot be removed');
            next = owner.clearSelection(next);
        } else {
            if (!owner.conditions) throw new TypeError('Condition has no selection owner');
            next = owner.conditions.remove(next, row.operator);
        }
        if (edit.type === 'remove') return next;
    }
    const condition = edit.condition;
    const owner = registry.find(field => field.id === condition.fieldId);
    if (!owner?.conditions || !owner.evaluators.includes(options.evaluator ?? 'list')
        || !owner.conditions.operators.includes(condition.operator)) throw new TypeError('Condition is not supported');
    // A changed row replaces itself: a scalar field's row stays present after its removal (its default value).
    const changed = edit.type === 'change' ? model.rows.find(row => row.id === edit.rowId) : undefined;
    const replacing = changed?.fieldId === condition.fieldId && changed.operator === condition.operator;
    if (!replacing && conditionModelFromFilter(registry, next, options).rows.some(row => row.id === rowId(condition.fieldId, condition.operator))) {
        throw new TypeError('Condition already exists; change its row instead');
    }
    return owner.conditions.replace(next, condition);
}
