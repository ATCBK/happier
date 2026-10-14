import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { ProviderAccountUsageRecordIdSchema, ProviderAccountUsageSnapshotV1Schema, type ProviderAccountUsageHistoryWitnessV1, type ProviderAccountUsageSnapshotV1 } from './providerAccountUsagePrimitives.js';
import { ProviderAccountSubscriptionV1Schema } from './accountSubscription.js';
import { ConnectedServiceQuotaMeterV1Schema } from './connectedServiceSchemas.js';

const RangeSchema = lazyZodSchema(() => z.strictObject({ startAtMs: z.number().check(z.int(), z.nonnegative()), endAtMs: z.number().check(z.int(), z.nonnegative()) }).check(z.refine(value => value.endAtMs > value.startAtMs)));
const EntrySchema = lazyZodSchema(() => z.strictObject({ id: z.string().check(z.minLength(1)), observedAtMs: z.number().check(z.int(), z.nonnegative()), snapshot: ProviderAccountUsageSnapshotV1Schema }));
function invalidProjectionEntries(projection: Readonly<{ recordId: string; range: Readonly<{ startAtMs: number; endAtMs: number }>;
  history: Readonly<{ entries: readonly Readonly<{ id: string; observedAtMs: number; snapshot: ProviderAccountUsageSnapshotV1 }>[] }> }>) {
  const ids = new Set<string>();
  const invalid: number[] = [];
  for (const [index, entry] of projection.history.entries.entries()) {
    if (entry.snapshot.recordId !== projection.recordId || entry.observedAtMs !== entry.snapshot.fetchedAtMs
      || entry.observedAtMs < projection.range.startAtMs || entry.observedAtMs >= projection.range.endAtMs || ids.has(entry.id)) invalid.push(index);
    ids.add(entry.id);
  }
  return invalid;
}
export const ProviderAccountUsagePageProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), recordId: ProviderAccountUsageRecordIdSchema, resolution: z.literal('accepted_observations'), range: RangeSchema,
  history: z.strictObject({ entries: z.array(EntrySchema), nextCursor: z.null() }),
}).check(z.superRefine((projection, context) => {
  for (const index of invalidProjectionEntries(projection)) context.addIssue({ code: 'custom', path: ['history', 'entries', index],
    message: 'Projection must retain exact admitted range, record and witnesses' });
})));
export type ProviderAccountUsagePageProjectionV1 = z.infer<typeof ProviderAccountUsagePageProjectionV1Schema>;
const BaseSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.omit(z.object(ProviderAccountUsageSnapshotV1Schema.shape), { observedAtMs: true, fetchedAtMs: true, meters: true, subscription: true })));
const SubscriptionMaterialSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.omit(z.object(ProviderAccountSubscriptionV1Schema.shape), { observedAtMs: true })));
const Index = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const Time = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
/** Dictionaries share material, not observations. Every accepted id and all three clocks remain exact. */
export const PackedProviderAccountUsagePageProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), recordId: ProviderAccountUsageRecordIdSchema, resolution: z.literal('accepted_observations'), range: RangeSchema,
  bases: z.array(BaseSchema), meters: z.array(ConnectedServiceQuotaMeterV1Schema), subscriptions: z.array(SubscriptionMaterialSchema),
  observations: z.array(z.tuple([z.string().check(z.minLength(1)), Time, Time, Time, Index, z.array(Index), z.nullable(Index), z.nullable(Time)])),
}));
export const ProviderAccountUsagePageProjectionContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: PackedProviderAccountUsagePageProjectionV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export const ProviderAccountUsagePageProjectionDemandV1Schema = lazyZodSchema(() => z.strictObject({
  range: RangeSchema, resolution: z.literal('accepted_observations'),
}));
export const StoredProviderAccountUsagePageProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  recordId: ProviderAccountUsageRecordIdSchema, demand: ProviderAccountUsagePageProjectionDemandV1Schema,
  frontier: z.nullable(z.strictObject({ id: z.string().check(z.minLength(1)), observedAtMs: Time })),
  observationCount: Index, content: ProviderAccountUsagePageProjectionContentV1Schema,
}).check(z.superRefine((stored, context) => {
  if (stored.content.t !== 'plain') return;
  const packed = stored.content.v;
  const last = packed.observations.at(-1);
  if (packed.recordId !== stored.recordId || packed.range.startAtMs !== stored.demand.range.startAtMs
    || packed.range.endAtMs !== stored.demand.range.endAtMs || packed.resolution !== stored.demand.resolution
    || packed.observations.length !== stored.observationCount
    || (last ? stored.frontier?.id !== last[0] || stored.frontier.observedAtMs !== last[1] : stored.frontier !== null)) {
    context.addIssue({ code: 'custom', path: ['content'], message: 'Projection coverage must identify its protected observations' });
  }
})));
export const ProviderAccountUsagePageProjectionWriteV1Schema = StoredProviderAccountUsagePageProjectionV1Schema;
export const ProviderAccountUsagePageProjectionReadV1Schema = lazyZodSchema(() => z.strictObject({
  projection: z.nullable(StoredProviderAccountUsagePageProjectionV1Schema),
  complete: z.boolean(),
}));

export function buildProviderAccountUsagePageProjectionV1(input: Readonly<{
  recordId: string; range: ProviderAccountUsagePageProjectionV1['range'];
  history: Readonly<{ entries: readonly z.infer<typeof EntrySchema>[]; nextCursor: unknown }>;
}>): ProviderAccountUsagePageProjectionV1 {
  return ProviderAccountUsagePageProjectionV1Schema.parse({ v: 1, recordId: input.recordId, range: input.range,
    resolution: 'accepted_observations', history: input.history });
}

export function sealProviderAccountUsagePageProjectionV1(input: Readonly<{ projection: ProviderAccountUsagePageProjectionV1;
  accountMode: 'plain' | 'e2ee'; material?: AccountScopedCryptoMaterial; randomBytes?: (length: number) => Uint8Array }>): z.infer<typeof ProviderAccountUsagePageProjectionContentV1Schema> {
  const projection = packProviderAccountUsagePageProjectionV1(input.projection);
  if (input.accountMode === 'plain') return { t: 'plain', v: projection };
  if (!input.material || !input.randomBytes) throw new Error('provider_account_usage_content_unavailable');
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'provider_account_usage_page_projection',
    material: input.material, randomBytes: input.randomBytes, payload: projection }) };
}

export function openProviderAccountUsagePageProjectionV1(input: Readonly<{ recordId: string; accountMode: 'plain' | 'e2ee';
  material?: AccountScopedCryptoMaterial; content: z.infer<typeof ProviderAccountUsagePageProjectionContentV1Schema> }>): ProviderAccountUsagePageProjectionV1 {
  const content = ProviderAccountUsagePageProjectionContentV1Schema.parse(input.content);
  if ((input.accountMode === 'plain') !== (content.t === 'plain')) throw new Error('provider_account_usage_content_mode_mismatch');
  const value = content.t === 'plain' ? content.v : input.material ? openAccountScopedBlobCiphertext({
    kind: 'provider_account_usage_page_projection', material: input.material, ciphertext: content.c })?.value : null;
  if (!value) throw new Error('provider_account_usage_content_unavailable');
  const projection = unpackProviderAccountUsagePageProjectionV1(PackedProviderAccountUsagePageProjectionV1Schema.parse(value));
  if (projection.recordId !== input.recordId) throw new Error('provider_account_usage_identity_mismatch');
  return projection;
}

export function packProviderAccountUsagePageProjectionV1(input: ProviderAccountUsagePageProjectionV1): z.infer<typeof PackedProviderAccountUsagePageProjectionV1Schema> {
  const projection = ProviderAccountUsagePageProjectionV1Schema.parse(input);
  const bases: z.infer<typeof BaseSchema>[] = [];
  const meters: z.infer<typeof ConnectedServiceQuotaMeterV1Schema>[] = [];
  const subscriptions: z.infer<typeof SubscriptionMaterialSchema>[] = [];
  const baseKeys = new Map<string, number>();
  const meterKeys = new Map<string, number>();
  const subscriptionKeys = new Map<string, number>();
  const intern = <T>(value: T, values: T[], keys: Map<string, number>) => {
    const key = JSON.stringify(value);
    const existing = keys.get(key);
    if (existing !== undefined) return existing;
    const index = values.length; keys.set(key, index); values.push(value); return index;
  };
  const observations: z.infer<typeof PackedProviderAccountUsagePageProjectionV1Schema>['observations'] = projection.history.entries.map(entry => {
    const { observedAtMs, fetchedAtMs, meters: snapshotMeters, subscription, ...base } = entry.snapshot;
    const subscriptionMaterial = subscription ? (({ observedAtMs: _at, ...value }) => value)(subscription) : null;
    return [entry.id, entry.observedAtMs, observedAtMs, fetchedAtMs, intern(base, bases, baseKeys),
      snapshotMeters.map(meter => intern(meter, meters, meterKeys)),
      subscriptionMaterial ? intern(subscriptionMaterial, subscriptions, subscriptionKeys) : null, subscription?.observedAtMs ?? null];
  });
  return { v: 1, recordId: projection.recordId, resolution: projection.resolution, range: projection.range, bases, meters, subscriptions, observations };
}

export function unpackProviderAccountUsagePageProjectionV1(input: z.infer<typeof PackedProviderAccountUsagePageProjectionV1Schema>): ProviderAccountUsagePageProjectionV1 {
  const packed = PackedProviderAccountUsagePageProjectionV1Schema.parse(input);
  // Validate composite snapshot identity once per admitted base. Meter and
  // subscription dictionaries were already validated once by the packed schema.
  const bases = packed.bases.map(base => {
    const { observedAtMs: _observed, fetchedAtMs: _fetched, meters: _meters, subscription: _subscription, ...validated } =
      ProviderAccountUsageSnapshotV1Schema.parse({ ...base, observedAtMs: 0, fetchedAtMs: 0, meters: [] });
    return validated;
  });
  const at = <T>(values: T[], index: number): T => {
    const value = values[index];
    if (value === undefined) throw new Error('provider_account_usage_content_unavailable');
    return value;
  };
  const projection: ProviderAccountUsagePageProjectionV1 = { v: packed.v, recordId: packed.recordId, resolution: packed.resolution, range: packed.range,
    history: { entries: packed.observations.map(([id, entryAt, observedAtMs, fetchedAtMs, base, meters, subscription, subscriptionAt]) => {
      if ((subscription === null) !== (subscriptionAt === null)) throw new Error('provider_account_usage_content_unavailable');
      const subscriptionValue = subscription === null || subscriptionAt === null ? undefined
        : { ...at(packed.subscriptions, subscription), observedAtMs: subscriptionAt };
      return { id, observedAtMs: entryAt, snapshot: { ...at(bases, base), observedAtMs, fetchedAtMs,
        meters: meters.map(index => at(packed.meters, index)),
        ...(subscriptionValue ? { subscription: subscriptionValue } : {}) } };
    }), nextCursor: null } };
  if (invalidProjectionEntries(projection).length) throw new Error('provider_account_usage_identity_mismatch');
  return projection;
}

const openedQuotaPageHistory = new WeakMap<z.infer<typeof PackedProviderAccountUsagePageProjectionV1Schema>, ProviderAccountUsagePageProjectionV1['history']>();
/** Decode once for consumers of the same admitted B value; this carries no read/freshness authority. */
export function getProviderAccountUsageQuotaHistoryV1(read: Readonly<{
  history?: { entries: z.infer<typeof EntrySchema>[]; nextCursor: ProviderAccountUsageHistoryWitnessV1 | null };
  pageProjection?: z.infer<typeof PackedProviderAccountUsagePageProjectionV1Schema>;
}>) {
  if (read.history) return read.history;
  if (!read.pageProjection) return undefined;
  let history = openedQuotaPageHistory.get(read.pageProjection);
  if (!history) {
    history = unpackProviderAccountUsagePageProjectionV1(read.pageProjection).history;
    openedQuotaPageHistory.set(read.pageProjection, history);
  }
  return history;
}
