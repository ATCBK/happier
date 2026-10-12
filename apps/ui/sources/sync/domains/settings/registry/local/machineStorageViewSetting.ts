import { z } from 'zod';

import type { LocalSettings } from '@/sync/domains/settings/localSettings';

const ShapeSchema = z.enum(['list', 'map', 'rings']);
const SortBySchema = z.enum(['name', 'size', 'items', 'changed', 'since']);
const SortDirectionSchema = z.enum(['asc', 'desc']);
const SortSchema = z.object({ by: SortBySchema, direction: SortDirectionSchema });

export const MACHINE_STORAGE_VIEW_DEFAULT = { shape: 'list', sort: { by: 'size', direction: 'desc' } } as const;

/** Preserve the existing tolerant device-data reader; Action inputs are admitted separately. */
export const MachineStorageViewMapSchema = z.record(z.string(), z.object({
    shape: ShapeSchema.catch('list'),
    sort: z.object({ by: SortBySchema.catch('size'), direction: SortDirectionSchema.catch('desc') })
        .catch(MACHINE_STORAGE_VIEW_DEFAULT.sort),
})).catch({});

/** The persisted identity is Home + NUL + Machine, including for equal IDs on different Homes. */
export const MachineStorageViewSettingKeySchema = z.string().regex(/^[^\u0000]+\u0000[^\u0000]+$/u);
export const MachineStorageViewSettingChangeSchema = z.object({
    shape: ShapeSchema.optional(),
    sort: SortSchema.strict().optional(),
}).strict().refine(value => value.shape !== undefined || value.sort !== undefined);
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
