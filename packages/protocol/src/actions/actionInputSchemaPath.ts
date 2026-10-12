import { z } from 'zod';

import type { ActionSpec } from './actionSpecs.js';

/**
 * Peels the wrappers that decorate an Action input field schema without changing
 * which value it describes, reporting whether any of them admits absence or null.
 */
export function unwrapActionInputSchema(
  schema: z.core.$ZodType,
): Readonly<{ schema: z.core.$ZodType; optional: boolean; nullable: boolean }> {
  let current = schema;
  let optional = false;
  let nullable = false;

  for (;;) {
    if (current instanceof z.ZodOptional) {
      optional = true;
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      optional = true;
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodNullable) {
      nullable = true;
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodPipe) {
      current = current.in as z.ZodTypeAny;
      continue;
    }
    break;
  }

  return { schema: current, optional, nullable };
}

/**
 * Whether the Action's own input schema declares `null` as a value of the field
 * at `path` — a stated "none" (for example `expectedItemRevision: null` requesting
 * creation), as distinct from context that is absent. A path the schema does not
 * describe structurally answers `false`.
 */
export function actionInputFieldAcceptsNull(
  spec: Pick<ActionSpec, 'inputSchema'>,
  path: string,
): boolean {
  const segments = path.split('.').map((part) => part.trim()).filter(Boolean);
  const acceptsNull = (schema: z.core.$ZodType, index: number): boolean => {
    if (index === segments.length) return z.safeParse(schema, null).success;
    const inner = unwrapActionInputSchema(schema).schema;
    if (inner instanceof z.ZodUnion) return inner.options.some((option) => acceptsNull(option, index));
    const segment = segments[index];
    if (segment === '[]') {
      if (!(inner instanceof z.ZodArray)) return false;
      return acceptsNull(inner.element as z.ZodTypeAny, index + 1);
    }
    if (!(inner instanceof z.ZodObject)) return false;
    const field = (inner.shape as Record<string, z.ZodTypeAny | undefined>)[segment!];
    return field !== undefined && acceptsNull(field, index + 1);
  };
  return spec.inputSchema !== undefined && acceptsNull(spec.inputSchema as z.ZodTypeAny, 0);
}
