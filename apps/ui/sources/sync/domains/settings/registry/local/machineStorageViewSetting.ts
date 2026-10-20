import { z } from 'zod/mini';

import type { LocalSettings } from '@/sync/domains/settings/localSettings';

const ShapeSchema = z.enum(['list', 'map', 'rings']);
const SortBySchema = z.enum(['name', 'size', 'items', 'changed', 'since']);
const SortDirectionSchema = z.enum(['asc', 'desc']);
const SortSchema = z.object({ by: SortBySchema, direction: SortDirectionSchema });

export const MACHINE_STORAGE_VIEW_DEFAULT = { shape: 'list', sort: { by: 'size', direction: 'desc' } } as const;

/** Preserve the existing tolerant device-data reader; Action inputs are admitted separately. */
export const MachineStorageViewMapSchema = z.catch(z.record(z.string(), z.object({
    shape: z.catch(ShapeSchema, 'list'),
    sort: z.catch(z.object({ by: z.catch(SortBySchema, 'size'), direction: z.catch(SortDirectionSchema, 'desc') }), MACHINE_STORAGE_VIEW_DEFAULT.sort),
})), {});

/** The persisted identity is Home + NUL + Machine, including for equal IDs on different Homes. */
export const MachineStorageViewSettingKeySchema = z.string().check(z.regex(/^[^\u0000]+\u0000[^\u0000]+$/u));
export const MachineStorageViewSettingChangeSchema = z.strictObject({
    shape: z.optional(ShapeSchema),
    sort: z.optional((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(SortSchema)),
}).check(z.refine(value => value.shape !== undefined || value.sort !== undefined));
export type MachineStorageViewSettingChange = z.infer<typeof MachineStorageViewSettingChangeSchema>;

export function readMachineStorageViewSetting(local: LocalSettings, key: string) {
    return local.machineStorageViewV1[key] ?? MACHINE_STORAGE_VIEW_DEFAULT;
}

/** Read the latest local map at commit so a shape/sort intent cannot replace another machine. */
export function buildMachineStorageViewSettingMutation(local: LocalSettings, key: string, change: MachineStorageViewSettingChange) {
    return { machineStorageViewV1: { ...local.machineStorageViewV1,
        [key]: { ...readMachineStorageViewSetting(local, key), ...change },
    } } satisfies Partial<LocalSettings>;
}
