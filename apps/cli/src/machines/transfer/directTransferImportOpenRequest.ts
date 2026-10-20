import { ComposerContentDisplayNameV1Schema, ComposerContentHandleV1Schema, ComposerContentMediaKindV1Schema, ComposerContentMimeTypeV1Schema } from '@happier-dev/protocol/runtime/input/composerContentV1';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { SessionExecutionTargetV1Schema } from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import { SessionAttachmentUploadInitRequestV1Schema } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentUploadInitRequestV1';
import { z } from 'zod/mini';
import { z as zMini } from 'zod/mini';

import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

const directTransferImportOpenCommonFields = {
  workingDirectory: z.string().check(z.minLength(1)),
  additionalAllowedWriteDirs: z.optional(z.array(z.string().check(z.minLength(1)))),
  sessionRpcTransferMaxBytes: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
};

const ComposerMediaStageUploadOpenRequestSchema = z.strictObject({
    ...directTransferImportOpenCommonFields,
    t: z.literal('composer_media_stage_upload_v1'),
    executionTarget: SessionExecutionTargetV1Schema,
    owner: asHostProtocolZod(PluginContributionIdentityV1Schema),
    mediaKind: ComposerContentMediaKindV1Schema,
    mimeType: ComposerContentMimeTypeV1Schema,
    name: ComposerContentDisplayNameV1Schema,
    sizeBytes: z.number().check(z.int(), z.positive()),
    sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/iu)),
  }).check(z.superRefine((value, context) => {
    const canonical = ComposerContentHandleV1Schema.safeParse({
      v: 1,
      id: 'direct-import-request',
      executionTarget: value.executionTarget,
      owner: value.owner,
      mediaKind: value.mediaKind,
      mimeType: value.mimeType,
      name: value.name,
      sizeBytes: value.sizeBytes,
      sha256: value.sha256,
    });
    if (!canonical.success) {
      context.addIssue({
        code: "custom",
        message: 'Invalid Composer media stage upload request',
      });
    }
  }));

export const DirectTransferImportOpenRequestSchema = z.discriminatedUnion('t', [
    z.strictObject({
      ...directTransferImportOpenCommonFields,
      t: z.literal('session_file_upload_v1'),
      path: z.unknown(),
      sizeBytes: z.unknown(),
      overwrite: z.unknown(),
      expectedHash: z.optional(z.unknown()),
      sha256: z.optional(z.unknown()),
    }),
    zMini.extend(SessionAttachmentUploadInitRequestV1Schema, directTransferImportOpenCommonFields),
    ComposerMediaStageUploadOpenRequestSchema,
  ]);
