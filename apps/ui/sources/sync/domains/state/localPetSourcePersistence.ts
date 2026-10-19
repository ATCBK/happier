import { z } from 'zod/mini';
import { PetAssetMediaTypeV1Schema } from '@happier-dev/protocol/pets/accountLibrary';
import { PetPackageManifestV1Schema } from '@happier-dev/protocol/pets/manifest';

import type { LocalPetSourceMetadata } from '@/sync/domains/pets/localPetSourceTypes';

import { getPersistenceStorage } from './persistenceStorage';

function localPetSourcesBySourceKeyKey(): string {
    return 'local-pet-sources-v1';
}

const SourceKeySchema = z.string().check(z.minLength(1), z.maxLength(500));
const PackagePathSchema = z.string().check(z.minLength(1), z.maxLength(10_000));

const LocalPetPackageSourceSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('detectedCodexHome'),
        homeKind: z.enum(['user', 'connectedService']),
        homePath: PackagePathSchema,
        packagePath: PackagePathSchema,
        sourceKey: SourceKeySchema,
    }),
    z.object({
        kind: z.literal('happierManagedLocal'),
        packagePath: PackagePathSchema,
        sourceKey: SourceKeySchema,
    }),
]);

const LocalPetSourceMetadataSchema = z.object({
    sourceKey: SourceKeySchema,
    source: LocalPetPackageSourceSchema,
    displayName: z.string().check(z.minLength(1), z.maxLength(200)),
    manifest: PetPackageManifestV1Schema,
    mediaType: PetAssetMediaTypeV1Schema,
    digest: z.nullable(z.string().check(z.minLength(1), z.maxLength(500))),
    sizeBytes: z.nullable(z.number().check(z.int(), z.minimum(0))),
    daemonTarget: z.object({
        serverId: z.string().check(z.minLength(1), z.maxLength(500)),
        machineId: z.string().check(z.minLength(1), z.maxLength(500)),
    }),
});

function parseLocalPetSourcesBySourceKey(input: unknown): Record<string, LocalPetSourceMetadata> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};

    const result: Record<string, LocalPetSourceMetadata> = {};
    for (const [sourceKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
        const parsed = LocalPetSourceMetadataSchema.safeParse(rawValue);
        if (!parsed.success) continue;
        if (parsed.data.sourceKey !== sourceKey) continue;
        if (parsed.data.source.sourceKey !== sourceKey) continue;
        result[sourceKey] = parsed.data;
    }

    return result;
}

export function loadLocalPetSourcesBySourceKey(): Record<string, LocalPetSourceMetadata> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(localPetSourcesBySourceKeyKey());
    if (!raw) return {};

    try {
        return parseLocalPetSourcesBySourceKey(JSON.parse(raw));
    } catch {
        return {};
    }
}

export function saveLocalPetSourcesBySourceKey(sources: Record<string, LocalPetSourceMetadata>): void {
    const mmkv = getPersistenceStorage();
    const parsed = parseLocalPetSourcesBySourceKey(sources);
    if (Object.keys(parsed).length === 0) {
        mmkv.delete(localPetSourcesBySourceKeyKey());
        return;
    }

    mmkv.set(localPetSourcesBySourceKeyKey(), JSON.stringify(parsed));
}
