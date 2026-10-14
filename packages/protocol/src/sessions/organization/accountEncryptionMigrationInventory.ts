import { z } from 'zod/mini';

import {
  SESSION_ORGANIZATION_MAX_FOLDERS,
  SESSION_ORGANIZATION_MAX_ID_LENGTH,
  SESSION_ORGANIZATION_MAX_KEY_LENGTH,
  SESSION_ORGANIZATION_MAX_LABELS,
  SESSION_ORGANIZATION_MAX_TAGS,
} from './constants.js';
import { SessionOrganizationContentEnvelopeSchema } from './contentSchemas.js';
import { SessionOrganizationLabelKindSchema } from './ordering.js';

const SessionOrganizationMigrationInventoryVersionSchema = z
  .number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER));

export const SessionOrganizationAccountEncryptionMigrationInventorySchema = z.strictObject({
    version: SessionOrganizationMigrationInventoryVersionSchema,
    folders: z.array(z.strictObject({
      folderId: z.string().check(z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)),
      display: SessionOrganizationContentEnvelopeSchema,
    })).check(z.maxLength(SESSION_ORGANIZATION_MAX_FOLDERS)),
    tags: z.array(z.strictObject({
      tagId: z.string().check(z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)),
      display: SessionOrganizationContentEnvelopeSchema,
    })).check(z.maxLength(SESSION_ORGANIZATION_MAX_TAGS)),
    labels: z.array(z.strictObject({
      labelKind: SessionOrganizationLabelKindSchema,
      scopeKey: z.string().check(z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_KEY_LENGTH)),
      display: SessionOrganizationContentEnvelopeSchema,
    })).check(z.maxLength(SESSION_ORGANIZATION_MAX_LABELS)),
  });

export type SessionOrganizationAccountEncryptionMigrationInventory = z.infer<
  typeof SessionOrganizationAccountEncryptionMigrationInventorySchema
>;
