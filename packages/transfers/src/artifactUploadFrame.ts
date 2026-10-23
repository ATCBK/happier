import { ArtifactBlobStoredContentV1Schema, ArtifactBlobUploadInitV1Schema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { ArtifactBlobStoredContentV1, ArtifactBlobUploadInitV1 } from '@happier-dev/protocol';
import { decodeBinaryUploadMetadataV1, encodeBinaryUploadMetadataV1, iterateBinaryUploadFrameV1 } from './binaryUploadFrame.js';

export const ARTIFACT_UPLOAD_CONTENT_TYPE_V1 = 'application/vnd.happier.artifact-upload-v1';
export const ARTIFACT_UPLOAD_PATH_V1 = '/v1/artifacts/content/upload';
type Destination<T> = T extends unknown ? Omit<T, 'sizeBytes' | 't'> : never;
export type ArtifactUploadDestinationV1 = Destination<ArtifactBlobUploadInitV1>;

function prepareArtifactUploadFrameV1(destination: ArtifactUploadDestinationV1, content: ArtifactBlobStoredContentV1) {
    const parsed = ArtifactBlobStoredContentV1Schema.parse(content);
    const bytes = decodeBase64(parsed.t === 'plain' ? parsed.v : parsed.c);
    const metadata = ArtifactBlobUploadInitV1Schema.parse({ ...destination, t: parsed.t, sizeBytes: bytes.byteLength });
    return { metadata, bytes };
}

/** A strict JSON metadata line followed by uninterpreted bytes, all on one HTTP request. */
export function encodeArtifactUploadFrameV1(destination: ArtifactUploadDestinationV1,
    content: ArtifactBlobStoredContentV1): Uint8Array<ArrayBuffer> {
    const { metadata, bytes } = prepareArtifactUploadFrameV1(destination, content);
    const prefix = encodeBinaryUploadMetadataV1(metadata);
    const frame = new Uint8Array(prefix.byteLength + bytes.byteLength);
    frame.set(prefix);
    frame.set(bytes, prefix.byteLength);
    return frame;
}

/** Streaming body consumers reuse one file allocation instead of an additional combined frame. */
export function iterateArtifactUploadFrameV1(destination: ArtifactUploadDestinationV1,
    content: ArtifactBlobStoredContentV1): AsyncGenerator<Uint8Array> {
    const { metadata, bytes } = prepareArtifactUploadFrameV1(destination, content);
    return iterateBinaryUploadFrameV1(metadata, [{ storedSizeBytes: bytes.byteLength, bytes }]);
}

export function decodeArtifactUploadMetadataV1(bytes: Uint8Array): ArtifactBlobUploadInitV1 {
    return ArtifactBlobUploadInitV1Schema.parse(decodeBinaryUploadMetadataV1(bytes));
}
