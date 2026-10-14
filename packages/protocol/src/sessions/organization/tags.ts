import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import {
  SESSION_ORGANIZATION_MAX_ID_LENGTH,
  SESSION_ORGANIZATION_MAX_KEY_LENGTH,
  SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH,
  SESSION_ORGANIZATION_MAX_TAGS,
} from './constants.js';
import {
  SessionOrganizationContentEnvelopeSchema,
  SessionOrganizationDisplayStateSchema,
} from './contentSchemas.js';

const SessionOrganizationSessionIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)));
const SessionOrganizationTagIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)));
const SessionOrganizationTagKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_KEY_LENGTH)));
const SessionOrganizationSortKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH)));

export const SessionOrganizationTagSchema = lazyZodSchema(() => z.strictObject({
    tagId: SessionOrganizationTagIdSchema,
    tagKey: SessionOrganizationTagKeySchema,
    sortKey: z.nullable(SessionOrganizationSortKeySchema),
    display: z.nullable(SessionOrganizationContentEnvelopeSchema),
    displayState: z.optional(SessionOrganizationDisplayStateSchema),
    archivedAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
    createdAt: z.number().check(z.int(), z.nonnegative()),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
  }));
export type SessionOrganizationTag = z.infer<typeof SessionOrganizationTagSchema>;

export const SessionTagAssignmentSchema = lazyZodSchema(() => z.strictObject({
    sessionId: SessionOrganizationSessionIdSchema,
    tagIds: z.array(SessionOrganizationTagIdSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_TAGS)),
  }));
export type SessionTagAssignment = z.infer<typeof SessionTagAssignmentSchema>;
