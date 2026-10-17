import * as z from 'zod/mini';

export type JsonSchemaObject = Readonly<Record<string, unknown>>;

/**
 * The Action catalog exports Zod's canonical JSON Schema projection. Callers
 * receive a stable, typed failure instead of a weakened object-shaped fallback
 * when Zod cannot represent a schema.
 */
export class ActionJsonSchemaProjectionError extends Error {
  readonly code: 'action_schema_unrepresentable' = 'action_schema_unrepresentable';

  constructor(reason: string) {
    super(`Action schema cannot be represented as JSON Schema: ${reason}`);
    this.name = 'ActionJsonSchemaProjectionError';
  }
}

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Zod 4.6 emits these check names as formats as well as their complete pattern
// constraints. They are not JSON Schema formats; keep the patterns portable.
const patternOnlyStringChecks = new Set(['starts_with', 'ends_with', 'includes', 'lowercase', 'uppercase']);

/**
 * Uses Zod's canonical JSON Schema projection, shared with public manifest
 * and contribution-schema tooling. Action schemas are parser contracts, so
 * their advertised shape is always the canonical input projection.
 */
export function zodSchemaToJsonSchemaObject(
  schema: z.core.$ZodType,
  options?: Readonly<{ target?: 'draft-2020-12' | 'draft-7'; reused?: 'inline' | 'ref'; override?: z.core.ToJSONSchemaParams['override'] }>,
): JsonSchemaObject {
  try {
    // The top-level projector supplies native processors for genuine Mini/Core
    // children; an instance method only carries its Classic processors.
    const projectedSchema = z.toJSONSchema(schema, {
      io: 'input',
      target: options?.target ?? 'draft-2020-12',
      reused: options?.reused ?? 'inline',
      unrepresentable: 'throw',
      override: context => {
        options?.override?.(context);
        const { jsonSchema } = context;
        if (typeof jsonSchema.format === 'string' && patternOnlyStringChecks.has(jsonSchema.format)
          && (typeof jsonSchema.pattern === 'string' || jsonSchema.allOf?.some(part => typeof part.pattern === 'string'))) {
          delete jsonSchema.format;
        }
      },
    });
    if (!isJsonSchemaObject(projectedSchema)) {
      throw new ActionJsonSchemaProjectionError('Zod produced a non-object JSON Schema');
    }

    // Zod decorates the root with non-enumerable Standard Schema methods. They
    // are useful on Zod values but are not JSON and cross realm boundaries
    // (notably voice-tool catalogs) as function-bearing metadata. Keep the
    // portable JSON Schema fields after the projection override.
    return Object.fromEntries(Object.entries(projectedSchema));
  } catch (error) {
    if (error instanceof ActionJsonSchemaProjectionError) throw error;
    const reason = error instanceof Error ? error.message : 'Zod projection failed';
    throw new ActionJsonSchemaProjectionError(reason);
  }
}
