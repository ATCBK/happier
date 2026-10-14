/** Protocol-internal Mini projection of the neutral composable schema. */
import * as mini from 'zod/mini';
import { createProtocolStoredReadSchema } from './protocolComposableSchema.js';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';

import type {
  ProtocolSchemaSafeParseResult,
} from './jsonSchemaValidation.js';

/**
 * This private adapter receives the neutral parser surface structurally. Its
 * typed signature retains concrete input/output projections without publishing
 * a validator identity through the neutral authoring API.
 */
type ProtocolComposableSchemaForZod<TInput, TOutput> = Readonly<{
  readonly jsonSchema: object;
  parse(value: TInput): TOutput;
  safeParse(value: unknown): ProtocolSchemaSafeParseResult<TOutput>;
  optional(): unknown;
  nullable(): unknown;
}>;

// Catalog parents repeatedly compose the same immutable neutral definitions.
// Share their one adapter by definition identity, never by JSON document shape.
const protocolZodFacades = new WeakMap<object, mini.ZodMiniType>();

export function asProtocolZod<TInput, TOutput>(
  schema: ProtocolComposableSchemaForZod<TInput, TOutput>,
): mini.ZodMiniType<TOutput, TInput> {
  const existing = protocolZodFacades.get(schema);
  // Each definition identity fixes the input/output projections of its adapter.
  if (existing) return existing as mini.ZodMiniType<TOutput, TInput>;
  const facade = mini.lazy(() => {
    // Keep refinement-before-transform: parent refinements explicitly opting
    // into failed admission must observe the original input, not NEVER.
    const createAdapter = (safeParse: (value: unknown) => ProtocolSchemaSafeParseResult<TOutput>) => {
      const admitted = mini.custom<TInput>().check(mini.superRefine((value, context) => {
        const parsed = safeParse(value);
        if (!parsed.success) {
          context.addIssue({
            code: 'custom',
            message: parsed.error.issues[0]?.message ?? 'Value does not match the canonical Protocol schema',
          });
        }
      }));
      const adapter = mini.pipe(admitted, mini.transform((value: TInput): TOutput => {
        const parsed = safeParse(value);
        if (!parsed.success) throw parsed.error;
        return parsed.data;
      }));
      return adapter;
    };
    const adapter = createAdapter((value) => schema.safeParse(value));

    // Zod cannot infer the portable schema hidden behind this neutral adapter.
    // Project the canonical Protocol-owned JSON Schema into exporters so public
    // authoring schemas retain the same admission constraints as runtime.
    adapter._zod.processJSONSchema = (_context, jsonSchema) => {
      Object.assign(jsonSchema, structuredClone(schema.jsonSchema));
    };

    return defineStoredReadProjection<mini.core.$ZodType<TOutput, TInput>>(adapter, () => {
      // The incumbent portable-schema owner already derives additive-open/drop
      // readers; keep its constraints rather than introducing another validator.
      const stored = createProtocolStoredReadSchema(schema);
      return createAdapter((value) => stored.safeParse(value));
    });
  });
  protocolZodFacades.set(schema, facade);
  return facade;
}
