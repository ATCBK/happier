import { z } from 'zod/mini';

/** Plaintext search hint only; access and content admission still open the private header. */
export const ArtifactCoarseKindV1Schema = z.enum(['skill', 'prompt', 'plugin_ui', 'work_board', 'widget_area_layout', 'widget_definition', 'widget_layout_fragment', 'other']);
export type ArtifactCoarseKindV1 = z.infer<typeof ArtifactCoarseKindV1Schema>;

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
