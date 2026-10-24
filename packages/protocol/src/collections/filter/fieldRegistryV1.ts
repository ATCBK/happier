import type { JsonValue } from '../../json/strictJsonValue.js';
import type { EntityFilterConditionCodecV1, EntityFilterConditionOperatorV1, EntityFilterConditionV1 } from './fieldConditionsV1.js';
export { createEntityFilterConditionCodecV1, type EntityFilterConditionCodecV1,
    type EntityFilterConditionOperatorV1, type EntityFilterConditionV1 } from './fieldConditionsV1.js';

export type EntityFilterMatchV1 = 'match' | 'miss' | 'unavailable';
export type EntityFilterEvaluatorV1 = 'list' | 'daemonRule';
export type EntityFilterFieldKindV1 = 'set' | 'boolean' | 'time' | 'domain';

export type EntityFilterFieldV1<Filter, Facts, Selection> = Readonly<{
    id: string;
    kind: EntityFilterFieldKindV1;
    evaluators: readonly EntityFilterEvaluatorV1[];
    readSelection(filter: Filter): Selection | undefined;
    replaceSelection(filter: Filter, selection: Selection | undefined): Filter;
    match(selection: Selection, facts: Facts): EntityFilterMatchV1;
    conditions?: EntityFilterConditionCodecV1<Selection>;
    /** Known-inapplicable entity kinds miss rather than masquerading as locked facts. */
    appliesTo?(facts: Facts): boolean;
}>;

/** Selection erasure happens only after its typed closure has captured it. */
export type CompilableEntityFilterFieldV1<Filter, Facts> = Readonly<{
    id: string;
    kind: EntityFilterFieldKindV1;
    evaluators: readonly EntityFilterEvaluatorV1[];
    isActive(filter: Filter): boolean;
    clearSelection?(filter: Filter): Filter;
    conditions?: Readonly<{
        operators: readonly EntityFilterConditionOperatorV1[];
        valueOptions: readonly JsonValue[];
        valueGroups?: EntityFilterConditionCodecV1<unknown>['valueGroups'];
        project(filter: Filter): readonly EntityFilterConditionV1[];
        replace(filter: Filter, condition: EntityFilterConditionV1): Filter;
        remove(filter: Filter, operator: EntityFilterConditionOperatorV1): Filter;
    }>;
    appliesTo?(facts: Facts): boolean;
    compile(filter: Filter, evaluator: EntityFilterEvaluatorV1): ((facts: Facts) => EntityFilterMatchV1) | undefined;
}>;
export type EntityFilterRegistryV1<Filter, Facts> = readonly CompilableEntityFilterFieldV1<Filter, Facts>[];

export function defineEntityFilterFieldV1<Filter, Facts, Selection>(
    field: EntityFilterFieldV1<Filter, Facts, Selection>,
): Omit<EntityFilterFieldV1<Filter, Facts, Selection>, 'conditions'> & CompilableEntityFilterFieldV1<Filter, Facts> {
    const { conditions, ...semanticField } = field;
    return {
        ...semanticField,
        ...(conditions ? { conditions: {
            operators: conditions.operators,
            get valueOptions() { return conditions.valueOptions; },
            get valueGroups() { return conditions.valueGroups; },
            project(filter: Filter) {
                const selection = field.readSelection(filter);
                return selection === undefined ? [] : conditions.project(selection);
            },
            replace: (filter: Filter, condition: EntityFilterConditionV1) => field.replaceSelection(filter,
                conditions.replace(field.readSelection(filter), condition)),
            remove(filter: Filter, operator: EntityFilterConditionOperatorV1) {
                const selection = field.readSelection(filter);
                return selection === undefined ? filter : field.replaceSelection(filter, conditions.remove(selection, operator));
            },
        } } : {}),
        isActive: filter => field.readSelection(filter) !== undefined,
        clearSelection: filter => field.replaceSelection(filter, undefined),
        compile(filter, evaluator) {
            const selection = field.readSelection(filter);
            if (selection === undefined) return undefined;
            const supported = field.evaluators.includes(evaluator);
            return facts => {
                if (field.appliesTo && !field.appliesTo(facts)) return 'miss';
                return supported ? field.match(selection, facts) : 'unavailable';
            };
        },
    };
}

export function getUnsupportedEntityFilterFieldsV1<Filter, Facts>(
    registry: EntityFilterRegistryV1<Filter, Facts>, filter: Filter, evaluator: EntityFilterEvaluatorV1,
): readonly string[] {
    return registry.filter(field => !field.evaluators.includes(evaluator) && field.isActive(filter)).map(field => field.id);
}

/** Future stored narrowing is never silently discarded by an older reader. */
export function defineEntityFilterUnknownFieldsV1<Filter extends object, Facts>(knownKeys: readonly string[]) {
    const known = new Set(knownKeys);
    return defineEntityFilterFieldV1<Filter, Facts, true>({
        id: 'unavailableFields', kind: 'domain', evaluators: [],
        readSelection: filter => Object.keys(filter).some(key => !known.has(key)) ? true : undefined,
        replaceSelection: filter => Object.fromEntries(Object.entries(filter).filter(([key]) => known.has(key))) as Filter,
        match: () => 'unavailable',
    });
}
