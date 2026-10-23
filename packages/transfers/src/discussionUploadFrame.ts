import { DiscussionAttachmentUploadRequestV1Schema } from '@happier-dev/protocol/discussions/attachmentsUpload';
import type { DiscussionAttachmentUploadRequestV1 } from '@happier-dev/protocol/discussions/attachmentsUpload';
import { DISCUSSION_HTTP_PATHS_V1 } from '@happier-dev/protocol/discussions/api';
import { decodeBinaryUploadMetadataV1, iterateBinaryUploadFrameV1, type BinaryUploadSegmentV1 } from './binaryUploadFrame.js';

export const DISCUSSION_UPLOAD_CONTENT_TYPE_V1 = 'application/vnd.happier.discussion-upload-v1';
export const DISCUSSION_UPLOAD_PATH_V1 = DISCUSSION_HTTP_PATHS_V1.upload;

export function decodeDiscussionUploadMetadataV1(bytes: Uint8Array): DiscussionAttachmentUploadRequestV1 {
    return DiscussionAttachmentUploadRequestV1Schema.parse(decodeBinaryUploadMetadataV1(bytes));
}

export function iterateDiscussionUploadFrameV1(metadata: DiscussionAttachmentUploadRequestV1,
    segments: readonly BinaryUploadSegmentV1[]): AsyncGenerator<Uint8Array> {
    const parsed = DiscussionAttachmentUploadRequestV1Schema.parse(metadata);
    if (parsed.attachments.length !== segments.length || segments.some((segment, index) =>
        segment.storedSizeBytes !== parsed.attachments[index]?.storedSizeBytes)) throw new Error('Discussion upload segments do not match metadata');
    return iterateBinaryUploadFrameV1(parsed, segments);
}
