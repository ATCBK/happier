/**
 * Protocol-internal bridge for legacy Zod parents.
 *
 * The public composable remains a neutral five-member value. This bridge is
 * deliberately not exported from a package entry point: it delegates parsing
 * and normalization straight back to that public value while an incumbent
 * internal Zod parent is migrated.
 */
import { z } from 'zod';
import * as mini from 'zod/mini';
import { createProtocolStoredReadSchema } from './protocolComposableSchema.js';
import { defineStoredReadProjection } from '../../json/storedReadSchema.js';

import type {
  ProtocolSchemaSafeParseResult,
} from './jsonSchemaValidation.js';

/**
 * This private bridge receives the neutral parser surface structurally. The
 * typed parser signature is deliberately separate from the broad public
 * admission overload so Zod parents retain concrete input/output projections
 * without publishing a validator identity or leaking private aliases into
 * generated SDK declarations.
 */
type ProtocolComposableSchemaForZod<TInput, TOutput> = Readonly<{
  readonly jsonSchema: object;
  parse(value: TInput): TOutput;
  safeParse(value: unknown): ProtocolSchemaSafeParseResult<TOutput>;
  optional(): unknown;
  nullable(): unknown;
}>;

// Catalog parents repeatedly compose the same immutable neutral definitions.
// Share their one facade by definition identity, never by JSON document shape.
const protocolZodFacades = new WeakMap<object, z.ZodType>();

export function asProtocolZod<TInput, TOutput>(
  schema: ProtocolComposableSchemaForZod<TInput, TOutput>,
): z.ZodType<TOutput, TInput> {
  const existing = protocolZodFacades.get(schema);
  // Each definition identity fixes the input/output projections of its facade.
  if (existing) return existing as z.ZodType<TOutput, TInput>;
  // This bridge exposes only ZodType, so Zod's native lazy combinator can
  // retain the actual adapter identity used by recursive JSON Schema exports.
  const facade = z.lazy(() => {
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
      // This is a fragment of the parent's document. Its exporter owns the root
      // dialect; the neutral schema remains an unchanged draft-07 document.
      const fragment = Object.fromEntries<unknown>(Object.entries(structuredClone(schema.jsonSchema))
        .filter(([keyword]) => keyword !== '$schema'));
      Object.assign(jsonSchema, fragment);
    };

    return defineStoredReadProjection<z.core.$ZodType<TOutput, TInput>>(adapter, () => {
      // The incumbent portable-schema owner already derives additive-open/drop
      // readers; keep its constraints rather than introducing another validator.
      const stored = createProtocolStoredReadSchema(schema);
      return createAdapter((value) => stored.safeParse(value));
    });
  });
  protocolZodFacades.set(schema, facade);
  return facade;
}
