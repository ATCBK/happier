import { z } from 'zod/mini';
import { PublicProfileOwnerRecordV1Schema, PublicProfilePublishBodyV1Schema, PublicProfileAppearanceV1Schema, type PublicProfileAppearanceV1, type PublicProfileContextV1, type PublicProfileMutationResultV1, type PublicProfileOwnerRecordV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { PublicProfilePolicyV1Schema, PublicProfileSnapshotV1Schema, PublicProfileMetadataV1Schema } from '@happier-dev/protocol/account/publicProfile';
import { PublicProfileLayoutV1Schema } from '@happier-dev/protocol/widgets/widgetPublicSnapshotV1';
import { UsageQuerySchema } from '@happier-dev/protocol/inputs/usageQuery';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { Tx } from '@/storage/inTx';

export interface PublicProfileServerDependencies {
    readPublicationContext(tx: Tx, accountId: string, env: NodeJS.ProcessEnv): Promise<PublicProfileContextV1>;
    resolvePrerequisite(env: NodeJS.ProcessEnv): 'report_contact_unconfigured' | 'public_ingress_unconfigured' | null;
}

type ProfileRow = NonNullable<Awaited<ReturnType<Tx['accountPublicProfile']['findUnique']>>>;
const storedMetadataSchema = z.strictObject({ disclosure: PublicProfileMetadataV1Schema,
    projectSelections: PublicProfilePublishBodyV1Schema.shape.projectSelections });

function parseStored<T>(schema: z.core.$ZodType<T>, raw: string | null): T | null {
    if (raw === null) return null;
    try { return z.parse(createStoredReadSchema(schema), JSON.parse(raw)); } catch { return null; }
}

export function readStoredPublicProfileAppearance(raw: string | null): PublicProfileAppearanceV1 | null {
    return parseStored(PublicProfileAppearanceV1Schema, raw);
}

/** A malformed known authority or payload never becomes a published record. */
export function parsePublicProfileRecord(row: ProfileRow): PublicProfileOwnerRecordV1 | null {
    const metadata = parseStored(storedMetadataSchema, row.metadataJson);
    const record = { state: row.state, policy: parseStored(PublicProfilePolicyV1Schema, row.policyJson),
        metadata: metadata?.disclosure ?? null, projectSelections: metadata?.projectSelections ?? [],
        query: parseStored(UsageQuerySchema, row.queryJson), snapshot: parseStored(PublicProfileSnapshotV1Schema, row.snapshotJson),
        layout: parseStored(PublicProfileLayoutV1Schema, row.layoutJson), appearance: readStoredPublicProfileAppearance(row.appearanceJson),
        updatedAtMs: row.updatedAt.getTime(), publishedAtMs: row.publishedAt?.getTime() ?? null,
        restriction: row.removedAt ? { removedAtMs: row.removedAt.getTime(), reason: row.removalReason ?? '' } : null };
    const payloads: readonly (readonly [string | null, unknown])[] = [[row.policyJson, record.policy], [row.metadataJson, metadata],
        [row.queryJson, record.query], [row.snapshotJson, record.snapshot], [row.layoutJson, record.layout], [row.appearanceJson, record.appearance]];
    if (payloads.some(([raw, value]) => raw !== null && value === null)) return null;
    const result = PublicProfileOwnerRecordV1Schema.safeParse(record);
    return result.success ? result.data : null;
}

export function publicProfileUnavailable(reason: Extract<PublicProfileMutationResultV1, { kind: 'unavailable' }>['reason']): PublicProfileMutationResultV1 {
    return { kind: 'unavailable', reason };
}
export function publicProfileUpdated(row: ProfileRow): PublicProfileMutationResultV1 {
    const record = parsePublicProfileRecord(row);
    return record ? { kind: 'updated', record } : publicProfileUnavailable('invalid_stored_content');
}
