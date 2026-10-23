import { z } from 'zod/mini';
import { createServerHttpRequestBodyItemBudgetV1 } from '../server/http/requestBodyBoundsV1.js';

/** Plaintext search hint only; access and content admission still open the private header. */
export const ArtifactCoarseKindV1Schema = z.enum(['skill', 'prompt', 'plugin_ui', 'work_board', 'widget_area_layout', 'widget_definition', 'widget_layout_fragment', 'other']);
export type ArtifactCoarseKindV1 = z.infer<typeof ArtifactCoarseKindV1Schema>;

export interface ArtifactKindV1 {
  kind: ArtifactCoarseKindV1;
  kindHint: string | null;
}

/** Existing MySQL Artifact.kind storage is VARCHAR(191), shared with the other providers. */
function fitsArtifactKindStorage(value: string): boolean {
  return Array.from(value).length <= 191;
}

/** Legacy coarse/null values remain unclassified. Exact kinds preserve the complete suffix. */
export function decodeArtifactKindV1(value: unknown): Readonly<{
  kind: ArtifactCoarseKindV1 | null; kindHint: string | null; classified: boolean;
}> {
  if (typeof value === 'string' && value.startsWith('v1:') && fitsArtifactKindStorage(value)) {
    const separator = value.indexOf(':', 3);
    const coarse = ArtifactCoarseKindV1Schema.safeParse(value.slice(3, separator));
    if (separator >= 3 && coarse.success) {
      return { kind: coarse.data, kindHint: value.slice(separator + 1) || null, classified: true };
    }
  }
  return { kind: ArtifactCoarseKindV1Schema.safeParse(value).data ?? null, kindHint: null, classified: false };
}

/** Writer admission accepts retained coarse writers and the current indexed representation. */
export const ArtifactStoredKindV1Schema = z.string().check(z.refine(value =>
  ArtifactCoarseKindV1Schema.safeParse(value).success || decodeArtifactKindV1(value).classified,
{ message: 'Invalid Artifact kind storage hint' }));

export const ArtifactKindWriteBatchInputV1Schema = z.strictObject({ items: z.array(z.strictObject({
  artifactId: z.string(), kind: ArtifactStoredKindV1Schema,
  expectedHeaderVersion: z.number().check(z.int(), z.minimum(0)),
})) });
export type ArtifactKindWriteBatchInputV1 = z.infer<typeof ArtifactKindWriteBatchInputV1Schema>;
export const ArtifactKindWriteBatchResponseV1Schema = z.strictObject({ items: z.array(z.discriminatedUnion('success', [
  z.strictObject({ artifactId: z.string(), success: z.literal(true) }),
  z.strictObject({ artifactId: z.string(), success: z.literal(false), error: z.string() }),
])) });
export type ArtifactKindWriteBatchResponseV1 = z.infer<typeof ArtifactKindWriteBatchResponseV1Schema>;

/** Frame only against the canonical HTTP byte ceiling; page demand owns item counts. */
export function frameArtifactKindWriteBatchesV1(items: readonly ArtifactKindWriteBatchInputV1['items'][number][]): readonly ArtifactKindWriteBatchInputV1[] {
  const batches: ArtifactKindWriteBatchInputV1[] = [];
  let current: ArtifactKindWriteBatchInputV1 = { items: [] };
  let budget = createServerHttpRequestBodyItemBudgetV1(current);
  for (const item of items) {
    if (!budget.tryAdmit(item)) {
      if (current.items.length > 0) batches.push(current);
      current = { items: [] };
      budget = createServerHttpRequestBodyItemBudgetV1(current);
      if (!budget.tryAdmit(item)) throw new RangeError('Artifact hint exceeds the HTTP request body budget');
    }
    current.items.push(item);
  }
  if (current.items.length > 0) batches.push(current);
  return batches;
}

export function encodeArtifactKindV1(value: ArtifactKindV1): string {
  const stored = `v1:${value.kind}:${value.kindHint ?? ''}`;
  if (!fitsArtifactKindStorage(stored)) throw new RangeError('Artifact kind exceeds its storage column');
  return stored;
}

/** Only the type discriminator leaves the private header; no title/name/content is extracted. */
export function deriveArtifactKindV1(header: Readonly<Record<string, unknown>>): ArtifactKindV1 {
  return { kind: deriveArtifactCoarseKindV1(header), kindHint: typeof header.kind === 'string' && header.kind.length > 0 ? header.kind : null };
}

export function deriveArtifactStoredKindV1(header: Readonly<Record<string, unknown>>): string {
  return encodeArtifactKindV1(deriveArtifactKindV1(header));
}

export function deriveArtifactCoarseKindV1(header: Readonly<Record<string, unknown>>): ArtifactCoarseKindV1 {
  // Inventory readers retain malformed skill identities so selected Sessions
  // can report unavailable content and GC cannot mistake them for absence.
  if (header.bundleSchemaId === 'skills.skill_md_v1') return 'skill';
  if (header.kind === 'prompt_doc.v2' || header.kind === 'prompt_bundle.v2') return 'prompt';
  if (header.kind === 'plugin.ui.archive') return 'plugin_ui';
  if (header.kind === 'work-board.v1') return 'work_board';
  if (header.kind === 'widget-area-layout.v1') return 'widget_area_layout';
  if (header.kind === 'widget-definition.v1') return 'widget_definition';
  if (header.kind === 'widget-layout-fragment.v1') return 'widget_layout_fragment';
  return 'other';
}
