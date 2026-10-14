import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import {
  SESSION_ORGANIZATION_MAX_ID_LENGTH,
  SESSION_ORGANIZATION_MAX_KEY_LENGTH,
  SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH,
} from './constants.js';
import {
  SessionOrganizationContentEnvelopeSchema,
  SessionOrganizationDisplayStateSchema,
} from './contentSchemas.js';

const SessionOrganizationFolderIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)));
const SessionOrganizationFolderKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_KEY_LENGTH)));
const SessionOrganizationSessionIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)));
const SessionOrganizationSortKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH)));

export const SessionOrganizationFolderSchema = lazyZodSchema(() => z.strictObject({
    folderId: SessionOrganizationFolderIdSchema,
    folderKey: SessionOrganizationFolderKeySchema,
    parentFolderId: z.nullable(SessionOrganizationFolderIdSchema),
    parentFolderKey: z.nullable(SessionOrganizationFolderKeySchema),
    sortKey: z.nullable(SessionOrganizationSortKeySchema),
    display: z.nullable(SessionOrganizationContentEnvelopeSchema),
    displayState: z.optional(SessionOrganizationDisplayStateSchema),
    archivedAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
    createdAt: z.number().check(z.int(), z.nonnegative()),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
  }));
export type SessionOrganizationFolder = z.infer<typeof SessionOrganizationFolderSchema>;

export const SessionFolderAssignmentSchema = lazyZodSchema(() => z.strictObject({
    sessionId: SessionOrganizationSessionIdSchema,
    folderId: SessionOrganizationFolderIdSchema,
  }));
export type SessionFolderAssignment = z.infer<typeof SessionFolderAssignmentSchema>;

export const SessionFolderAssignmentMutationResultSchema = lazyZodSchema(() => z.strictObject({
    sessionId: SessionOrganizationSessionIdSchema,
    folderId: z.nullable(SessionOrganizationFolderIdSchema),
  }));
export type SessionFolderAssignmentMutationResult = z.infer<typeof SessionFolderAssignmentMutationResultSchema>;
