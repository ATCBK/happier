import type { JsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';

function asObject(value: unknown): JsonSchemaObject | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonSchemaObject : undefined;
}

function requiredFields(schema: JsonSchemaObject): string[] {
    return Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [];
}

function referencedObject(document: JsonSchemaObject, ref: unknown): JsonSchemaObject | undefined {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
    let value: unknown = document;
    for (const part of ref.slice(2).split('/')) {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
        const object = asObject(value);
        if (!object || !Object.hasOwn(object, key)) return undefined;
        value = object[key];
    }
    return asObject(value);
}

/** Rewrite schema references without interpreting literal const/default/enum data. */
export function rewriteMcpJsonSchemaReferences(schema: JsonSchemaObject, rewrite: (ref: string) => string): JsonSchemaObject {
    const result: Record<string, unknown> = { ...schema };
    if (typeof schema.$ref === 'string') result.$ref = rewrite(schema.$ref);
    for (const key of ['properties', 'definitions', '$defs']) {
        const entries = asObject(schema[key]);
        if (entries) result[key] = Object.fromEntries(Object.entries(entries).map(([name, child]) =>
            [name, asObject(child) ? rewriteMcpJsonSchemaReferences(child as JsonSchemaObject, rewrite) : child]));
    }
    for (const key of ['items', 'additionalProperties', 'propertyNames', 'not']) {
        const child = asObject(schema[key]);
        if (child) result[key] = rewriteMcpJsonSchemaReferences(child, rewrite);
    }
    for (const key of ['anyOf', 'oneOf', 'allOf', 'items']) {
        const children = schema[key];
        if (Array.isArray(children)) result[key] = children.map(child =>
            asObject(child) ? rewriteMcpJsonSchemaReferences(child, rewrite) : child);
    }
    return result;
}

/**
 * Provider-facing presentation only. MCP arguments remain the original flat
 * object, and the original Action/plugin validator still checks every call.
 * Providers reject root combinators, so expose their fields on one object:
 * alternatives require only common fields; intersections combine requirements.
 * Cross-field/variant correlations remain authoritative at call validation.
 */
export function projectMcpToolInputJsonSchema(schema: JsonSchemaObject): JsonSchemaObject {
    const projected = projectObjectInputSchema(schema, schema, new Set());
    const removed = ['anyOf', 'oneOf', 'allOf'].filter(key => Array.isArray(schema[key]));
    if (removed.length === 0) return projected;
    const definitions = asObject(schema.definitions) ?? {};
    let name = 'happierMcpInput';
    while (Object.hasOwn(definitions, name)) name += '_';
    const pointer = `#/definitions/${name}`;
    let needsOriginal = false;
    const rewrite = (ref: string) => {
        if (ref === '#' || removed.some(key => ref.startsWith(`#/${key}/`))) {
            needsOriginal = true;
            return `${pointer}${ref.slice(1)}`;
        }
        return ref;
    };
    const original = rewriteMcpJsonSchemaReferences(schema, rewrite);
    if (!needsOriginal) return projected;
    const relocated = rewriteMcpJsonSchemaReferences(projected, rewrite);
    // Only retain a source definition when an advertised reference needs its
    // removed root path (or recursive root). Call validation still uses schema.
    return { ...relocated, definitions: { ...asObject(relocated.definitions), [name]: original } };
}

function projectObjectInputSchema(input: JsonSchemaObject, document: JsonSchemaObject, ancestors: ReadonlySet<JsonSchemaObject>): JsonSchemaObject {
    const visited = new Set(ancestors).add(input);
    const referenced = referencedObject(document, input.$ref);
    let schema = input;
    if (referenced && !visited.has(referenced)) {
        const { $ref: _ref, ...siblings } = input;
        schema = { ...siblings, allOf: [referenced, ...(Array.isArray(input.allOf) ? input.allOf : [])] };
    }
    const result: Record<string, unknown> = { ...schema, type: 'object' };
    let properties = { ...asObject(schema.properties) };
    const required = new Set(requiredFields(schema));
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
        const rawBranches = schema[key];
        if (!Array.isArray(rawBranches)) continue;
        const branches = rawBranches.map(branch => projectObjectInputSchema(asObject(branch) ?? {}, document, visited));
        const names = new Set(branches.flatMap(branch => Object.keys(asObject(branch.properties) ?? {})));
        const projectedProperties: Record<string, unknown> = {};
        for (const name of names) {
            const alternatives = branches.flatMap(branch => {
                const fields = asObject(branch.properties) ?? {};
                if (Object.hasOwn(fields, name)) return [fields[name]];
                if (key === 'allOf') return [];
                // An open alternative can accept a field declared by another
                // branch, so its additional-property schema must also be allowed.
                return branch.additionalProperties === false ? [] : [branch.additionalProperties ?? {}];
            });
            const unique = [...new Map(alternatives.map(value => [JSON.stringify(value), value])).values()];
            projectedProperties[name] = unique.length === 1 ? unique[0] : { [key === 'allOf' ? 'allOf' : 'anyOf']: unique };
        }
        properties = Object.fromEntries([...new Set([...Object.keys(properties), ...names])].map(name => {
            if (!Object.hasOwn(properties, name)) return [name, projectedProperties[name]];
            if (!Object.hasOwn(projectedProperties, name)) return [name, properties[name]];
            return [name, { allOf: [properties[name], projectedProperties[name]] }];
        }));
        const branchRequired = branches.map(requiredFields);
        for (const name of branchRequired.flat()) {
            if (key === 'allOf' || branchRequired.every(fields => fields.includes(name))) required.add(name);
        }
        const closed = (branch: JsonSchemaObject) => branch.additionalProperties === false && branch.patternProperties === undefined;
        if (result.additionalProperties === undefined && branches.length > 0
            && (key === 'allOf' ? branches.some(closed) : branches.every(closed))) {
            result.additionalProperties = false;
        }
        delete result[key];
    }
    result.properties = properties;
    if (required.size > 0) result.required = [...required];
    return result;
}
