import type { ActionDiscoveryDefinitionV1 } from './actionDefinitionV1.js';
import type { JsonSchemaObject } from './actionInputJsonSchema.js';

function escapePointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function describeDefinition(body: unknown, name: string): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return `Shared grammar ${name}`;
  const schema = body as JsonSchemaObject;
  if (typeof schema.description === 'string') return schema.description;
  if (typeof schema.title === 'string') return schema.title;
  if (Array.isArray(schema.enum)) return `${name}: ${schema.enum.length} allowed values`;
  const properties = schema.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    return `${name}: object fields ${Object.keys(properties).join(', ')}`;
  }
  return `${name}: ${typeof schema.type === 'string' ? schema.type : 'alternative shapes'}`;
}

/** Read only own schema properties; a pointer never addresses metadata or prototypes. */
function readSchemaSection(definition: ActionDiscoveryDefinitionV1, path: string): JsonSchemaObject {
  const parts = path.split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!path.startsWith('/') || !['inputSchema', 'outputSchema'].includes(parts[0])) throw new Error('invalid_schema_path');
  if (parts.length % 2 !== 1 || parts.some((part, index) => index % 2 === 1 && part !== 'definitions')) throw new Error('invalid_schema_path');
  let value: unknown = definition;
  for (const part of parts) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) throw new Error('invalid_schema_path');
    value = (value as Readonly<Record<string, unknown>>)[part];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_schema_path');
  return value as JsonSchemaObject;
}

/**
 * Tools read the same canonical schema in named sections, never a truncated schema.
 * Definitions are already emitted by Zod's shared-schema projection. Keep their
 * local references intact; section paths are relative to the original full spec.
 */
export function projectActionSpecSchemaSections(definition: ActionDiscoveryDefinitionV1, schemaPath?: string) {
  const reference = (path: string) => ({ $ref: `happier-action-spec:${encodeURIComponent(definition.id)}#${path}` });
  const schemaSections: { path: string; description: string }[] = [];
  const project = (schema: JsonSchemaObject, root: string): JsonSchemaObject => {
    const definitions = schema.definitions;
    if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) return schema;
    for (const [name, body] of Object.entries(definitions)) {
      const path = `/${root}/definitions/${escapePointer(name)}`;
      schemaSections.push({ path, description: describeDefinition(body, name) });
    }
    const { definitions: _definitions, ...rootSchema } = schema;
    return rootSchema;
  };
  if (schemaPath !== undefined) return {
    actionSpec: { ...definition, inputSchema: reference('/inputSchema'),
      ...(definition.outputSchema ? { outputSchema: reference('/outputSchema') } : {}) },
    schemaSection: { path: schemaPath, schema: project(readSchemaSection(definition, schemaPath), schemaPath.slice(1)) }, schemaSections,
  };
  const actionSpec = { ...definition, inputSchema: project(definition.inputSchema, 'inputSchema'),
    ...(definition.outputSchema ? { outputSchema: project(definition.outputSchema, 'outputSchema') } : {}) };
  return { actionSpec, schemaSections };
}
