import { type ArtifactBlobReferenceV1, type ArtifactBlobStoredContentV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import type { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { HappyError } from '@/utils/errors/errors';
import { hashBinaryContent, openBinaryContent, sealBinaryContent } from '@/sync/encryption/binaryContent';

export function hashArtifactBinaryContent(bytes: Uint8Array): string {
    return hashBinaryContent(bytes);
}

export async function sealArtifactBinaryContent(bytes: Uint8Array, mode: 'plain' | 'e2ee', encryption: ArtifactEncryption | null): Promise<ArtifactBlobStoredContentV1> {
    try { return await sealBinaryContent(bytes, mode, encryption); }
    catch (error) { throw artifactBinaryError(error); }
}

/** One binary opening owner for ordinary reads and Account conversion. */
export async function openArtifactBinaryContent(input: Readonly<{
    reference: ArtifactBlobReferenceV1;
    content: ArtifactBlobStoredContentV1;
    mode: 'plain' | 'e2ee';
    encryption: ArtifactEncryption | null;
}>): Promise<Uint8Array> {
    try { return await openBinaryContent(input); }
    catch (error) { throw artifactBinaryError(error); }
}

function artifactBinaryError(error: unknown): unknown {
    if (!(error instanceof HappyError)) return error;
    return new HappyError(error.message, false, { code: error.code === 'binary_account_mode_mismatch'
        ? 'artifact_account_mode_mismatch' : 'artifact_content_unavailable' });
}
