import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import type { RuntimeActionIdV1 } from '../actionIds.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

export type RuntimeActionSpecTextMap = Readonly<Partial<Record<RuntimeActionIdV1, string>>>;

export type RuntimeActionSchemaMap = Readonly<Partial<Record<RuntimeActionIdV1, z.ZodMiniType>>>;

export type RuntimeActionSpecFamily = Readonly<{
  confirmationFacts?: Readonly<Partial<Record<RuntimeActionIdV1, Pick<PreNormalizedActionSpec, 'confirmVerb' | 'irreversible'>>>>;
  approvalPolicies?: Readonly<Partial<Record<RuntimeActionIdV1, PreNormalizedActionSpec['approvalPolicy']>>>;
  /** Input paths the approval page reads under Technical details (see ActionSpec `approvalPresentation`). */
  approvalTechnicalInputPaths?: Readonly<Partial<Record<RuntimeActionIdV1, readonly string[]>>>;
  /** Domain-written request summaries, for Actions whose spec description is agent-facing (see ActionSpec `approvalPresentation`). */
  approvalSummaries?: Readonly<Partial<Record<RuntimeActionIdV1, (input: unknown) => string | null>>>;
  titles: RuntimeActionSpecTextMap;
  descriptions?: RuntimeActionSpecTextMap;
  /** Canonical per-id schema rows for public/runtime projections. */
  inputSchemas?: RuntimeActionSchemaMap;
  outputSchemas?: RuntimeActionSchemaMap;
}>;

export const PassthroughEmptyObjectSchema = lazyZodSchema(() => z.looseObject({}));

export function refineKindSchema(
  schema: z.ZodMiniType,
  field: string,
  expected: string,
  label: string,
): z.ZodMiniType {
  return schema.check(z.refine((value) => (value as Record<string, unknown>)[field] === expected, {
    message: `${label} must be ${expected}.`,
    path: [field],
  }));
}
