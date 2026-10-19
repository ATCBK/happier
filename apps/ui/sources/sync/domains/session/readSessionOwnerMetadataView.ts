import { type Metadata } from '@happier-dev/session-core/state';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { SessionOwnerMetadataV1Schema, type SessionOwnerMetadataEnvelopeV1, type SessionOwnerMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';

/** In-memory provenance travels with the Session/list projection, never with wire or warm-cache data. */
export const SESSION_OWNER_METADATA_PROJECTION = Symbol('sessionOwnerMetadataProjection');
export type SessionOwnerMetadataProjection = Readonly<{
  kind: 'owner';
  ownerMetadataEnvelope: SessionOwnerMetadataEnvelopeV1;
  ownerMetadata: SessionOwnerMetadataV1;
  canReuse?: (input: Readonly<{
    accountMode?: AccountEncryptionCurrentnessResponse['mode'];
    credentials: object;
    ownerMetadataEnvelope: unknown;
  }>) => boolean;
}>;

type SessionOwnerMetadataViewInput = Readonly<{
  metadataLayoutVersion?: number;
  metadata?: unknown;
  ownerMetadataView?: unknown;
}>;

/**
 * Whether this device can currently read a session's owner metadata view, and
 * — when it cannot — why.
 *
 * The two unreadable causes have opposite lifetimes and opposite remedies.
 * `not_projected` is transient: the layout is understood, but the owner
 * projection for this session has not landed or has not been decrypted yet, so
 * the very same read can succeed moments later. `unsupported_layout_version` is
 * durable: the server wrote a layout this build does not know, and only a newer
 * client can read it. A caller that sees only a bare `null` cannot tell them
 * apart, and treating the transient gap as the durable fault turns a normal
 * hydration race into a permanent refusal.
 */
export type SessionOwnerMetadataViewRead =
  | Readonly<{ kind: 'available'; metadata: Metadata }>
  | Readonly<{ kind: 'not_projected' }>
  | Readonly<{ kind: 'unsupported_layout_version' }>;

const NOT_PROJECTED: SessionOwnerMetadataViewRead = Object.freeze({ kind: 'not_projected' as const });
const UNSUPPORTED_LAYOUT_VERSION: SessionOwnerMetadataViewRead = Object.freeze({
  kind: 'unsupported_layout_version' as const,
});
const ownerViewPreferencesReadSchema = createStoredReadSchema(
  SessionOwnerMetadataV1Schema.shape.work._zod.def.innerType.shape.viewPreferences,
);

function readMetadataView(value: unknown): SessionOwnerMetadataViewRead {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.freeze({ kind: 'available' as const, metadata: value as Metadata })
    : NOT_PROJECTED;
}

/** Sole owner of session metadata-layout knowledge for owner-view reads. */
export function resolveSessionOwnerMetadataViewRead(
  session: SessionOwnerMetadataViewInput,
): SessionOwnerMetadataViewRead {
  const metadataLayoutVersion = readSessionMetadataLayoutVersion(session.metadataLayoutVersion);
  if (metadataLayoutVersion === 0) {
    // An explicit null is producer-owned unavailability, including scoped frame reads.
    if (session.ownerMetadataView === null) return NOT_PROJECTED;
    return readMetadataView(session.metadata);
  }
  if (metadataLayoutVersion !== 1) {
    return UNSUPPORTED_LAYOUT_VERSION;
  }
  return readMetadataView(session.ownerMetadataView);
}

export function readSessionOwnerMetadataView(
  session: SessionOwnerMetadataViewInput,
): Metadata | null {
  const read = resolveSessionOwnerMetadataViewRead(session);
  return read.kind === 'available' ? read.metadata : null;
}

/** Read only the canonical preference leaf; retained plugin work remains untouched. */
export function readSessionOwnerMetadataViewPreferences(
  metadata: unknown,
): NonNullable<NonNullable<SessionOwnerMetadataV1['work']>['viewPreferences']> | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const work: unknown = Reflect.get(metadata, 'work');
  if (work === null || typeof work !== 'object' || Array.isArray(work)) return null;
  const parsed = ownerViewPreferencesReadSchema.safeParse(Reflect.get(work, 'viewPreferences'));
  return parsed.success ? parsed.data ?? null : null;
}
