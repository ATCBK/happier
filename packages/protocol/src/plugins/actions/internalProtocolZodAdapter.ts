/** Protocol-internal Mini projection of the neutral composable schema. */
import * as mini from 'zod/mini';
import { createProtocolStoredReadSchema, projectProtocolStoredReadJsonSchema } from './protocolComposableSchema.js';
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
    const createAdapter = (safeParse: (value: unknown) => ProtocolSchemaSafeParseResult<TOutput>, projectJsonSchema: () => object) => {
      // A native transform alone advertises optional input. The custom input
      // boundary retains requiredness; only the final transform can refuse.
      const adapter = mini.pipe(mini.custom<TInput>(), mini.transform<TInput, TOutput>((value, context) => {
        const parsed = safeParse(value);
        if (parsed.success) return parsed.data;
        context.issues.push({
          code: 'custom',
          input: value,
          message: parsed.error.issues[0]?.message ?? 'Value does not match the canonical Protocol schema',
        });
        // Admission has failed. Preserve its original input for parent checks
        // explicitly opting in; no rejected value can become a parsed output.
        return value as unknown as TOutput;
      }));
      // Each native adapter projects its own canonical write or stored-read
      // document only when a JSON exporter actually traverses it.
      adapter._zod.processJSONSchema = (_context, jsonSchema) => {
        // This is a fragment of the parent's document. Its exporter owns the
        // root dialect; the neutral owner stays an unchanged draft-07 document.
        const fragment = Object.fromEntries<unknown>(Object.entries(projectJsonSchema())
          .filter(([keyword]) => keyword !== '$schema'));
        Object.assign(jsonSchema, fragment);
      };
      return adapter;
    };
    const adapter = createAdapter((value) => schema.safeParse(value), () => structuredClone(schema.jsonSchema));

    return defineStoredReadProjection<mini.core.$ZodType<TOutput, TInput>>(adapter, () => {
      // The incumbent portable-schema owner already derives additive-open/drop
      // readers; keep its constraints rather than introducing another validator.
      const stored = createProtocolStoredReadSchema(schema);
      return createAdapter((value) => stored.safeParse(value), () => projectProtocolStoredReadJsonSchema(schema.jsonSchema).document);
    });
  });
  protocolZodFacades.set(schema, facade);
  return facade;
}
