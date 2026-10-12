import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
import { PluginUiSemanticCommandV1Schema } from './semanticCommands.js';

/**
 * Explicitly tells a reader that this surface withheld invalid context.
 * It is a data-only detail fragment:
 * it never carries a command payload, identity, or execution authority.
 */
export const CurrentUiContextBoundedIncompletenessV1Schema = lazyZodSchema(() => z.object({
  incomplete: z.literal(true),
}).strict());
export type CurrentUiContextBoundedIncompletenessV1 = Readonly<
  z.infer<typeof CurrentUiContextBoundedIncompletenessV1Schema>
>;
export const CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1:
  CurrentUiContextBoundedIncompletenessV1 = Object.freeze({ incomplete: true });

const CurrentUiTextV1Schema = lazyZodSchema(() => z.string().trim().min(1));

export const CurrentUiContextEntityV1Schema = lazyZodSchema(() => z.object({
  kind: CurrentUiTextV1Schema,
  label: CurrentUiTextV1Schema,
  summary: CurrentUiTextV1Schema.optional(),
  reference: PluginUiJsonValueV1Schema.optional(),
}).strict());
export type CurrentUiContextEntityV1 = z.infer<typeof CurrentUiContextEntityV1Schema>;

export const CurrentUiCommandDeclarationV1Schema = lazyZodSchema(() => z.object({
  title: CurrentUiTextV1Schema,
  description: CurrentUiTextV1Schema.optional(),
  command: PluginUiSemanticCommandV1Schema,
}).strict());
export type CurrentUiCommandDeclarationV1 = z.infer<typeof CurrentUiCommandDeclarationV1Schema>;

/** A host-generated opaque command handle; semantic payloads never cross it. */
export const CurrentUiCommandDescriptorV1Schema = lazyZodSchema(() => z.object({
  id: CurrentUiTextV1Schema,
  title: CurrentUiTextV1Schema,
  description: CurrentUiTextV1Schema.optional(),
}).strict());
export type CurrentUiCommandDescriptorV1 = z.infer<typeof CurrentUiCommandDescriptorV1Schema>;

export const PluginUiContextEnrichmentV1Schema = lazyZodSchema(() => z.object({
  entity: CurrentUiContextEntityV1Schema.optional(),
  detail: PluginUiJsonValueV1Schema.optional(),
  commands: z.array(CurrentUiCommandDeclarationV1Schema).optional(),
}).strict());
export type PluginUiContextEnrichmentV1 = z.infer<typeof PluginUiContextEnrichmentV1Schema>;

export const CurrentUiContextSnapshotV1Schema = lazyZodSchema(() => z.object({
  navigation: z.object({
    area: CurrentUiTextV1Schema,
    screen: CurrentUiTextV1Schema,
    title: CurrentUiTextV1Schema.optional(),
    presentation: z.enum(['screen', 'modal', 'pane']).optional(),
  }).strict(),
  entity: CurrentUiContextEntityV1Schema.optional(),
  detail: PluginUiJsonValueV1Schema.optional(),
  commands: z.array(CurrentUiCommandDescriptorV1Schema),
}).strict());
export type CurrentUiContextSnapshotV1 = z.infer<typeof CurrentUiContextSnapshotV1Schema>;
