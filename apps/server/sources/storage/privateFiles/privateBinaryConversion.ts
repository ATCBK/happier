import { createHash } from 'node:crypto';
import type { BinaryBlobAccountEncryptionStageV1 } from '@happier-dev/protocol/storage/binaryBlobV1';

export const privateBinaryContentDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export type PrivateBinaryConversionRow = Readonly<{ storageKey: string; encryptionMode: string; storedSizeBytes: bigint }>;
export type PreparedPrivateBinaryConversion<TRow extends PrivateBinaryConversionRow> = Readonly<{
    source: TRow; expectedContentSha256: string; sourceSizeBytes: number;
    target: Readonly<{ accountId: string; row: TRow; candidate: boolean; contentSha256: string; sizeBytes: number }>;
}>;

/** Artifact and Discussion conversion share byte verification and replay materialization.
 * Resource adapters alone decide ownership, retained references and exact stage custody.
 */
export async function preparePrivateBinaryConversion<TRow extends PrivateBinaryConversionRow>(input: Readonly<{
    accountId: string; source: TRow; target: TRow; stage: BinaryBlobAccountEncryptionStageV1;
    expectedContentSha256: string; open: (row: TRow) => Promise<Uint8Array>;
}>): Promise<PreparedPrivateBinaryConversion<TRow> | null> {
    if (input.target.encryptionMode !== (input.stage.t === 'plain' ? 'plain' : 'e2ee')) return null;
    const replay = input.source.storageKey === input.target.storageKey;
    const targetBytes = await input.open(input.target);
    const contentSha256 = privateBinaryContentDigest(targetBytes);
    if (contentSha256 !== input.stage.contentSha256) return null;
    const sourceBytes = replay ? null : await input.open(input.source);
    if (sourceBytes && privateBinaryContentDigest(sourceBytes) !== input.expectedContentSha256) return null;
    return { source: input.source, expectedContentSha256: input.expectedContentSha256, sourceSizeBytes: sourceBytes?.byteLength ?? targetBytes.byteLength,
        target: { accountId: input.accountId, row: input.target, candidate: !replay, contentSha256, sizeBytes: targetBytes.byteLength } };
}
