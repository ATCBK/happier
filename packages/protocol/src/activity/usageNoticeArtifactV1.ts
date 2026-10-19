import { z } from 'zod/mini';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { AccountNoticePageV1Schema } from './accountNoticePageV1.js';
export { AccountNoticePageV1Schema } from './accountNoticePageV1.js';
import { ConnectedServiceUsageNotificationV1Schema, MachineVitalsNotificationV1Schema, SourceFollowUpdateNotificationV1Schema } from './webhookPayload.js';
import { USAGE_NOTICE_ARTIFACT_KIND_V1, ACCOUNT_NOTICE_ARTIFACT_KIND_V1 } from './accountNoticeArtifactKindsV1.js';
export { USAGE_NOTICE_ARTIFACT_KIND_V1, ACCOUNT_NOTICE_ARTIFACT_KIND_V1 } from './accountNoticeArtifactKindsV1.js';

const UsageNoticeV1Schema = lazyZodSchema(() => z.union([
  ConnectedServiceUsageNotificationV1Schema, MachineVitalsNotificationV1Schema,
]));

export const UsageNoticeArtifactHeaderV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), kind: z.literal(USAGE_NOTICE_ARTIFACT_KIND_V1), title: z.string().check(z.minLength(1)),
  status: z.enum(['open', 'dismissed']), notice: UsageNoticeV1Schema,
  // The incumbent Artifact writer refreshes this body-derived encrypted preview.
  excerpt: z.optional(z.string()),
}));
export const UsageNoticeArtifactBodyV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), notice: UsageNoticeV1Schema,
}));
export type UsageNoticeArtifactHeaderV1 = z.infer<typeof UsageNoticeArtifactHeaderV1Schema>;

// Mutation/identity/routing objects are closed. Stored readers drop unknown
// presentation fields; they never turn them into source or routing authority.
export const AccountNoticeItemTypeV1Schema = lazyZodSchema(() => z.enum(['decision', 'approval', 'blocked', 'update', 'mention']));
export const AccountNoticeSourceV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('plugin'), pluginId: z.string().check(z.minLength(1)), itemId: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('host'), topic: z.enum(['connected_service_usage', 'resource_limit', 'follow_update']) }),
]));
// The containing stored document may drop retired presentation fields, while
// source identity and executable page routing stay closed on read and write.
defineStoredReadProjection(AccountNoticeSourceV1Schema, () => AccountNoticeSourceV1Schema);
const accountNoticeContent = {
  v: z.literal(1), source: AccountNoticeSourceV1Schema, type: AccountNoticeItemTypeV1Schema,
  resolved: z.boolean(), page: z.optional(AccountNoticePageV1Schema), body: z.optional(z.string()),
  notice: z.optional(z.union([UsageNoticeV1Schema, SourceFollowUpdateNotificationV1Schema])),
};
export const AccountNoticeArtifactBodyV1Schema = lazyZodSchema(() => z.strictObject(accountNoticeContent).check(z.refine(value =>
  value.source.kind === 'host' ? value.notice?.topic === value.source.topic && value.page === undefined : value.notice === undefined)));
export const AccountNoticeArtifactHeaderV1Schema = lazyZodSchema(() => z.strictObject({
  ...accountNoticeContent, kind: z.literal(ACCOUNT_NOTICE_ARTIFACT_KIND_V1), title: z.string().check(z.minLength(1)),
  status: z.enum(['open', 'dismissed']), readAt: z.optional(z.number().check(z.int(), z.nonnegative())), excerpt: z.optional(z.string()),
}).check(z.refine(value =>
  value.source.kind === 'host' ? value.notice?.topic === value.source.topic && value.page === undefined : value.notice === undefined)));
export type AccountNoticeArtifactHeaderV1 = z.infer<typeof AccountNoticeArtifactHeaderV1Schema>;

export function readAccountNoticeArtifactHeaderV1(raw: unknown): AccountNoticeArtifactHeaderV1 | null {
  const parsed = createStoredReadSchema(AccountNoticeArtifactHeaderV1Schema).safeParse(raw);
  return parsed.success ? parsed.data : null;
}
export function readAccountNoticeArtifactV1(input: Readonly<{ header: unknown; body: unknown }>): AccountNoticeArtifactHeaderV1 | null {
  const header = readAccountNoticeArtifactHeaderV1(input.header);
  if (!header || typeof input.body !== 'string') return null;
  try {
    const body = createStoredReadSchema(AccountNoticeArtifactBodyV1Schema).safeParse(JSON.parse(input.body));
    const expected = AccountNoticeArtifactBodyV1Schema.parse(Object.fromEntries(Object.keys(accountNoticeContent)
      .filter(key => Reflect.get(header, key) !== undefined).map(key => [key, Reflect.get(header, key)])));
    return body.success && sameStrictJsonValue(body.data, expected) ? header : null;
  } catch { return null; }
}

/** Content validation is not audience admission; readers retain Artifact access/mode checks. */
export function readUsageNoticeArtifactHeaderV1(raw: unknown): UsageNoticeArtifactHeaderV1 | null {
  const parsed = createStoredReadSchema(UsageNoticeArtifactHeaderV1Schema).safeParse(raw);
  return parsed.success ? parsed.data : null;
}
export function readUsageNoticeArtifactV1(input: Readonly<{ header: unknown; body: unknown }>): UsageNoticeArtifactHeaderV1 | null {
  const header = readUsageNoticeArtifactHeaderV1(input.header);
  if (!header || typeof input.body !== 'string') return null;
  try {
    const body = createStoredReadSchema(UsageNoticeArtifactBodyV1Schema).safeParse(JSON.parse(input.body));
    return body.success && sameStrictJsonValue(body.data.notice, header.notice) ? header : null;
  } catch { return null; }
}
