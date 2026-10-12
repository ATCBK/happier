import * as mini from 'zod/mini';
import {
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
  type ProtocolSchemaOutput,
} from '@happier-dev/plugin-sdk/protocol';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
const sandboxId = defineProtocolString({ pattern: '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$' });
const snapshotName = defineProtocolString({ pattern: '^[a-z0-9][a-z0-9-]{0,62}$' });
const size = defineProtocolUnion([
  defineProtocolLiteral('small'), defineProtocolLiteral('default'),
  defineProtocolLiteral('large'), defineProtocolLiteral('xlarge'),
]);

export const BoatLaunchV1Schema = defineProtocolObject({
  size,
  source: defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('blank') }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('named-snapshot'), name: snapshotName }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('fork'), sandboxId }, closed),
  ]),
}, closed);

export const BoatResourceV1Schema = defineProtocolObject({ sandboxId }, closed);
export const BoatAcquireOperationV1Schema = defineProtocolObject({
  kind: defineProtocolLiteral('acquire'),
  idempotencyKey: defineProtocolString({ minLength: 1, maxLength: 255 }),
  requestFingerprint: text,
  sourceKind: defineProtocolUnion([
    defineProtocolLiteral('blank'), defineProtocolLiteral('named-snapshot'), defineProtocolLiteral('fork'),
  ]),
  requestedAtMs: defineProtocolNumber({ integer: true, minimum: 0 }),
  sandboxId: sandboxId.optional(),
}, closed);
export const BoatDeleteOperationV1Schema = defineProtocolObject({
  kind: defineProtocolLiteral('delete'),
  operationId: defineProtocolString({ pattern: '^bdop_[a-f0-9]{32}$' }),
  sandboxId,
}, closed);
export const BoatNativeOperationV1Schema = defineProtocolUnion([
  BoatAcquireOperationV1Schema,
  BoatDeleteOperationV1Schema,
]);

export type BoatLaunchV1 = ProtocolSchemaOutput<typeof BoatLaunchV1Schema>;
export type BoatResourceV1 = ProtocolSchemaOutput<typeof BoatResourceV1Schema>;
export type BoatAcquireOperationV1 = ProtocolSchemaOutput<typeof BoatAcquireOperationV1Schema>;
export type BoatDeleteOperationV1 = ProtocolSchemaOutput<typeof BoatDeleteOperationV1Schema>;
export type BoatNativeOperationV1 = ProtocolSchemaOutput<typeof BoatNativeOperationV1Schema>;

export class BoatNativeError extends Error {
  constructor(readonly code: string, readonly retryable = false) {
    super(code);
    this.name = 'BoatNativeError';
  }
}

export function parseBoatValue<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, code = 'native_response_invalid'): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BoatNativeError(code);
  return parsed.data;
}

export const BoatPublicKeySchema = mini.string().check(mini.regex(/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]+)?$/));
