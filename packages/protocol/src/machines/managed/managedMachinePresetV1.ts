import { z } from 'zod/mini';
import * as mini from 'zod/mini';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { AccountPrincipalRefV1Schema, TeamPrincipalRefV1Schema } from '../../teams/principal.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { ManagedRefusalCodeV1Schema } from './providerFactsV1.js';
import { ManagedControllerV1Schema, ReusableRetentionV1Schema, createValidatedLaunchSnapshotV1Schema } from './managedMachineV1.js';
import { MachineEnvironmentV1Schema } from './machineEnvironmentV1.js';
export { MachineEnvironmentV1Schema, MachineEnvironmentV1ReadSchema, type MachineEnvironmentV1 } from './machineEnvironmentV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const revision = () => z.number().check(z.int(), z.nonnegative());

export const ManagedMachinePresetOwnerV1Schema = lazyZodSchema(() => z.union([
  AccountPrincipalRefV1Schema, TeamPrincipalRefV1Schema,
]));
export const ManagedMachinePresetLimitV1Schema = lazyZodSchema(() => z.strictObject({ maximum: z.number().check(z.int(), z.positive()) }));

/** Recipes are future choices. The contributed validator owns the native choice shape. */
export function createManagedMachinePresetV1Schema<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.strictObject({
    id: id(), homeId: id(), revision: revision(), name: id(),
    owner: ManagedMachinePresetOwnerV1Schema,
    recipe: createValidatedLaunchSnapshotV1Schema(choices),
    controller: ManagedControllerV1Schema,
    environment: z.optional(MachineEnvironmentV1Schema),
    retention: mini.optional(ReusableRetentionV1Schema),
    wakeOnAcceptedMessage: z.optional(z.boolean()),
    simultaneousLimit: z.optional(ManagedMachinePresetLimitV1Schema),
    archivedAt: z.optional(z.number().check(z.nonnegative())),
  });
}

/** Transport validates the envelope; save/use additionally validate the selected contribution. */
export const ManagedMachinePresetV1Schema = lazyZodSchema(() => createManagedMachinePresetV1Schema(PluginJsonValueV2Schema));
export const ManagedMachinePresetV1ReadSchema = createStoredReadSchema(ManagedMachinePresetV1Schema);
export type ManagedMachinePresetV1 = z.infer<typeof ManagedMachinePresetV1Schema>;

export const ManagedMachinePresetCreateInputV1Schema = lazyZodSchema(() => z.omit(ManagedMachinePresetV1Schema, { revision: true, archivedAt: true }));
export const ManagedMachinePresetGetInputV1Schema = lazyZodSchema(() => z.strictObject({ homeId: id(), id: id() }));
export const ManagedMachinePresetListInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), owner: z.optional(ManagedMachinePresetOwnerV1Schema), search: z.optional(z.string()),
  includeArchived: z.optional(z.boolean()), cursor: z.optional(id()),
}));
export const ManagedMachinePresetUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), id: id(), expectedRevision: revision(),
  patch: z.strictObject({
    name: z.optional(id()),
    recipe: mini.optional(createValidatedLaunchSnapshotV1Schema(PluginJsonValueV2Schema)),
    controller: mini.optional(ManagedControllerV1Schema),
    environment: z.optional(z.nullable(MachineEnvironmentV1Schema)),
    retention: mini.optional(mini.nullable(ReusableRetentionV1Schema)),
    wakeOnAcceptedMessage: z.optional(z.nullable(z.boolean())),
    simultaneousLimit: z.optional(z.nullable(ManagedMachinePresetLimitV1Schema)),
  }),
}));
export const ManagedMachinePresetRevisionInputV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: id(), id: id(), expectedRevision: revision(),
}));
export const ManagedMachinePresetRefusalCodeV1Schema = ManagedRefusalCodeV1Schema;
export const ManagedMachinePresetRefusedV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('refused'), code: ManagedMachinePresetRefusalCodeV1Schema,
}));
export const PresetMutationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('saved'), preset: ManagedMachinePresetV1Schema }),
  z.strictObject({ kind: z.literal('conflict'), currentRevision: revision() }),
  ManagedMachinePresetRefusedV1Schema,
]));
export const ManagedMachinePresetGetResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('found'), preset: ManagedMachinePresetV1Schema }),
  ManagedMachinePresetRefusedV1Schema,
]));
export const ManagedMachinePresetListResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('listed'), presets: z.array(ManagedMachinePresetV1Schema), cursor: z.optional(id()) }),
  ManagedMachinePresetRefusedV1Schema,
]));
export type ManagedMachinePresetCreateInputV1 = z.infer<typeof ManagedMachinePresetCreateInputV1Schema>;
export type ManagedMachinePresetUpdateInputV1 = z.infer<typeof ManagedMachinePresetUpdateInputV1Schema>;
export type ManagedMachinePresetGetInputV1 = z.infer<typeof ManagedMachinePresetGetInputV1Schema>;
export type ManagedMachinePresetListInputV1 = z.infer<typeof ManagedMachinePresetListInputV1Schema>;
export type ManagedMachinePresetRevisionInputV1 = z.infer<typeof ManagedMachinePresetRevisionInputV1Schema>;
export type PresetMutationResultV1 = z.infer<typeof PresetMutationResultV1Schema>;
export type ManagedMachinePresetGetResultV1 = z.infer<typeof ManagedMachinePresetGetResultV1Schema>;
export type ManagedMachinePresetListResultV1 = z.infer<typeof ManagedMachinePresetListResultV1Schema>;
