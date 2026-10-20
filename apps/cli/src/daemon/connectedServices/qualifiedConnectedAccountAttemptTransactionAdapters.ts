import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { ConnectedAccountSourceCustodyV1Schema, connectedAccountSourceCustodyV1Equal } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { StoredJsonContentEnvelopeSchema, isStoredJsonContentEnvelopeModeCompatible } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { openQualifiedConnectedAccountContentEnvelope, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { StoredJsonContentEnvelope } from '@happier-dev/protocol';
import { z } from 'zod/mini';

import {
  createConnectedAccountAttemptTransactionApi,
  type ConnectedAccountAttemptTransactionRecord,
  type ConnectedAccountAttemptTransactionScope,
  type ConnectedAccountAttemptTransactionStoreApi,
} from '@/api/client/connectedAccountAttemptTransactionApi';
import type { ConnectedServiceAccountEncryptionMode } from '@/api/client/connectedServiceCredentialApi';
import { generatePkceCodes } from '@/cloud/pkce';
import type { StoredCredentials } from '@/persistence';
import type {
  ConnectedAccountDeviceTransactionSnapshot,
  ConnectedAccountOAuthCallbackCompletion,
  ConnectedAccountOAuthTransaction,
  ConnectedAccountOAuthTransactionOwner,
  ConnectedAccountOAuthTransactionSnapshot,
} from '@/plugins/runtime/connectedAccounts/authenticationAttemptOwner';

import {
  requireConnectedAccountCryptoMaterial,
  resolveConnectedAccountCryptoMaterial,
} from './accountScopedCryptoMaterial';
import type {
  QualifiedConnectedAccountAttemptTransactionAdapters,
} from './qualifiedConnectedAccountDaemonPersistence';

// The transaction route admits custody for at most 24 hours. Provider expiry
// (when supplied) owns any earlier end; redirect/device phases add no deadline.
const MAX_TRANSACTION_TTL_MS = 24 * 60 * 60_000;

const BoundedIdSchema = z.string().check(z.minLength(1), z.maxLength(256));
const SafeTimestampSchema = z.number().check(z.int(), z.nonnegative());
const ServiceSchema = z.strictObject({
  pluginId: BoundedIdSchema,
  localId: BoundedIdSchema,
});
const AccountSchema = z.strictObject({
  service: ServiceSchema,
  accountId: BoundedIdSchema,
});
const StagedCredentialsSchema = z.record(
  z.string().check(z.minLength(1), z.maxLength(128)),
  z.string(),
);
const ProviderIdentitySchema = z.strictObject({
  accountId: z.optional(BoundedIdSchema),
  email: z.optional(z.string().check(z.minLength(1), z.maxLength(4_096))),
});
const PreparedSettlementShape = {
  intent: z.enum(['connect', 'reconnect']),
  service: ServiceSchema,
  accountId: BoundedIdSchema,
  authenticationModeId: BoundedIdSchema,
  directExportContract: z.optional(z.nullable(z.literal(CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1))),
  expectedCredentialRevision: z.nullable(z.string().check(z.maxLength(4_096))),
  expectedCredentialConfigurationRevision:
    z.nullable(z.string().check(z.minLength(1), z.maxLength(4_096))),
  expectedConfigurationRevision: z.string().check(z.minLength(1), z.maxLength(4_096)),
  stagedCredentials: StagedCredentialsSchema,
  stagedAccountConfigurationContent: z.optional(z.unknown()),
  providerIdentity: z.optional(ProviderIdentitySchema),
  displayName: z.string().check(z.maxLength(4_096)),
  scopes: z.array(z.string().check(z.maxLength(4_096))).check(z.maxLength(256)),
} as const;
const PreparedSettlementSchema = z.strictObject({
  ...PreparedSettlementShape,
  sourceCustody: ConnectedAccountSourceCustodyV1Schema,
});
const SnapshotCommonShape = {
  attemptId: BoundedIdSchema,
  createdAtMs: SafeTimestampSchema,
  intent: z.enum(['connect', 'reconnect']),
  service: ServiceSchema,
  account: z.optional(AccountSchema),
  modeId: BoundedIdSchema,
  expectedCredentialRevision: z.nullable(z.string().check(z.maxLength(4_096))),
  expectedCredentialConfigurationRevision:
    z.nullable(z.string().check(z.minLength(1), z.maxLength(4_096))),
  expectedConfigurationRevision: z.string().check(z.minLength(1), z.maxLength(4_096)),
  stagedCredentials: StagedCredentialsSchema,
  stagedAccountConfigurationContent: z.optional(z.unknown()),
} as const;
const SnapshotBaseShape = {
  ...SnapshotCommonShape,
  sourceCustody: ConnectedAccountSourceCustodyV1Schema,
  preparedSettlement: z.optional(PreparedSettlementSchema),
} as const;
const OAuthSnapshotSchema = z.strictObject({
  ...SnapshotBaseShape,
  phase: z.enum(['starting', 'awaitingOAuth', 'outcomeUnknown']),
  authorizationUrl: z.optional(z.string().check(z.minLength(1))),
  issuer: z.optional(z.string().check(z.minLength(1))),
  issuerResponseParameterRequired: z.optional(z.boolean()),
  expiresAtMs: z.optional(SafeTimestampSchema),
});
const DeviceSnapshotSchema = z.strictObject({
  ...SnapshotBaseShape,
  expiresAtMs: SafeTimestampSchema,
  pollIntervalMs: z.number().check(z.int(), z.positive()),
  nextPollAtMs: SafeTimestampSchema,
  verificationUri: z.string().check(z.minLength(1)),
  verificationUriComplete: z.optional(z.string().check(z.minLength(1))),
  userCode: z.string().check(z.minLength(1)),
});
const OAuthPayloadSchema = z.strictObject({
  version: z.literal(2),
  kind: z.literal('oauth'),
  snapshot: OAuthSnapshotSchema,
  state: z.string().check(z.minLength(32), z.maxLength(4_096)),
  challenge: z.string().check(z.minLength(32), z.maxLength(256)),
  verifier: z.string().check(z.minLength(43), z.maxLength(128)),
  callbackUrl: z.string().check(z.minLength(1)),
  consumed: z.boolean(),
});
const DevicePayloadSchema = z.strictObject({
  version: z.literal(2),
  kind: z.literal('device'),
  snapshot: DeviceSnapshotSchema,
});
type OAuthPayload = z.infer<typeof OAuthPayloadSchema>;
type DevicePayload = z.infer<typeof DevicePayloadSchema>;

function defaultRandomBytes(length: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(length));
}

function sameService(
  left: ConnectedAccountOAuthTransactionSnapshot['service'],
  right: ConnectedAccountOAuthTransactionSnapshot['service'],
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function sameAccount(
  left: ConnectedAccountOAuthTransactionSnapshot['account'],
  right: ConnectedAccountOAuthTransactionSnapshot['account'],
): boolean {
  if (!left || !right) return left === right;
  return sameQualifiedConnectedAccountRef(left, right);
}

function sameSnapshotIdentity(
  left: ConnectedAccountOAuthTransactionSnapshot | ConnectedAccountDeviceTransactionSnapshot,
  right:
    | ConnectedAccountOAuthTransactionSnapshot
    | ConnectedAccountDeviceTransactionSnapshot,
): boolean {
  return left.attemptId === right.attemptId
    && left.createdAtMs === right.createdAtMs
    && left.intent === right.intent
    && sameService(left.service, right.service)
    && sameAccount(left.account, right.account)
    && left.modeId === right.modeId
    && connectedAccountSourceCustodyV1Equal(left.sourceCustody, right.sourceCustody)
    && left.expectedCredentialRevision === right.expectedCredentialRevision
    && left.expectedCredentialConfigurationRevision
      === right.expectedCredentialConfigurationRevision
    && left.expectedConfigurationRevision === right.expectedConfigurationRevision
    && (isDeepStrictEqual(
      left.stagedAccountConfigurationContent,
      right.stagedAccountConfigurationContent,
    ) || (left.sourceCustody.kind === 'host' && 'phase' in left && left.phase === 'starting'));
}

function assertOAuthSnapshotAdvance(
  current: ConnectedAccountOAuthTransactionSnapshot,
  next: ConnectedAccountOAuthTransactionSnapshot,
): void {
  const phaseRank: Readonly<
    Record<ConnectedAccountOAuthTransactionSnapshot['phase'], number>
  > = {
    starting: 0,
    awaitingOAuth: 1,
    outcomeUnknown: 2,
  };
  if (
    !sameSnapshotIdentity(current, next)
    || phaseRank[next.phase] < phaseRank[current.phase]
    || (
      current.authorizationUrl !== undefined
      && current.authorizationUrl !== next.authorizationUrl
    )
    || (current.issuer !== undefined && current.issuer !== next.issuer)
    || (current.issuerResponseParameterRequired !== undefined
      && current.issuerResponseParameterRequired !== next.issuerResponseParameterRequired)
    || (
      current.preparedSettlement !== undefined
      && !isDeepStrictEqual(current.preparedSettlement, next.preparedSettlement)
    )
  ) {
    throw new Error(
      'Connected-account OAuth transaction acknowledgement is invalid',
    );
  }
}

function assertDeviceSnapshotAdvance(
  current: ConnectedAccountDeviceTransactionSnapshot,
  next: ConnectedAccountDeviceTransactionSnapshot,
): void {
  if (
    !sameSnapshotIdentity(current, next)
    || current.expiresAtMs !== next.expiresAtMs
    || current.verificationUri !== next.verificationUri
    || current.verificationUriComplete !== next.verificationUriComplete
    || current.userCode !== next.userCode
    || next.nextPollAtMs < current.nextPollAtMs
    || (
      current.preparedSettlement !== undefined
      && !isDeepStrictEqual(current.preparedSettlement, next.preparedSettlement)
    )
  ) {
    throw new Error(
      'Connected-account device transaction acknowledgement is invalid',
    );
  }
}

function transactionExpiresAt(input: Readonly<{
  now: number;
  ttlMs: number;
  providerExpiresAtMs?: number;
}>): number {
  const hostExpiry = input.now + input.ttlMs;
  return input.providerExpiresAtMs === undefined
    ? hostExpiry
    : Math.min(hostExpiry, input.providerExpiresAtMs);
}

export function createQualifiedConnectedAccountAttemptTransactionAdapters(
  params: Readonly<{
    credentials: StoredCredentials;
    /**
     * Persisted `Account.encryptionMode` is the sole representation authority. Attempt
     * durability is installed for every Account, plaintext included, and the mode —
     * never key presence — decides whether content is sealed or stored plainly.
     */
    getAccountEncryptionMode: () => Promise<ConnectedServiceAccountEncryptionMode>;
    getMachineId: () => string;
    api?: ConnectedAccountAttemptTransactionStoreApi;
    randomBytes?: (length: number) => Uint8Array;
    transactionTtlMs?: number;
    now?: () => number;
  }>,
): Required<QualifiedConnectedAccountAttemptTransactionAdapters> {
  const api =
    params.api
    ?? createConnectedAccountAttemptTransactionApi({
      token: params.credentials.token,
    });
  const randomBytes = params.randomBytes ?? defaultRandomBytes;
  const transactionTtlMs =
    params.transactionTtlMs ?? MAX_TRANSACTION_TTL_MS;
  const now = params.now ?? Date.now;
  if (
    !Number.isSafeInteger(transactionTtlMs)
    || transactionTtlMs <= 0
    || transactionTtlMs > MAX_TRANSACTION_TTL_MS
  ) {
    throw new Error('Connected-account attempt transaction TTL is invalid');
  }
  const material = resolveConnectedAccountCryptoMaterial(params.credentials);

  function scopeFor(
    snapshot: ConnectedAccountOAuthTransactionSnapshot | ConnectedAccountDeviceTransactionSnapshot,
  ): ConnectedAccountAttemptTransactionScope {
    return Object.freeze({
      machineId: params.getMachineId(),
      service: snapshot.service,
      modeId: snapshot.modeId,
      intent: snapshot.intent,
      phase: 'phase' in snapshot ? snapshot.phase : 'awaitingDeviceAuthorization',
      createdAtMs: snapshot.createdAtMs,
    });
  }

  async function resolveAccountMode(): Promise<'plain' | 'e2ee'> {
    const mode = await params.getAccountEncryptionMode();
    if (mode === 'unknown') {
      throw new Error(
        'Connected-account attempt transaction account encryption mode is unavailable',
      );
    }
    return mode;
  }

  async function seal(
    payload: OAuthPayload | DevicePayload,
  ): Promise<StoredJsonContentEnvelope> {
    const accountMode = await resolveAccountMode();
    return accountMode === 'plain'
      ? sealQualifiedConnectedAccountContentEnvelope({
        kind: 'attempt',
        accountMode: 'plain',
        payload,
        randomBytes,
      })
      : sealQualifiedConnectedAccountContentEnvelope({
        kind: 'attempt',
        accountMode: 'e2ee',
        material: requireConnectedAccountCryptoMaterial(
          params.credentials,
          material,
        ),
        payload,
        randomBytes,
      });
  }

  async function open(
    record: ConnectedAccountAttemptTransactionRecord,
  ): Promise<unknown> {
    const accountMode = await resolveAccountMode();
    const envelope = createStoredReadSchema(StoredJsonContentEnvelopeSchema).parse(record.content);
    // The persisted Account mode and the stored envelope kind must agree before any
    // content is disclosed. A mismatch is an inconsistent record, never a reason to
    // try the other branch.
    if (!isStoredJsonContentEnvelopeModeCompatible(accountMode, envelope)) {
      throw new Error(
        'Connected-account attempt transaction content does not match the persisted Account encryption mode',
      );
    }
    const opened = accountMode === 'plain'
      ? openQualifiedConnectedAccountContentEnvelope({
        kind: 'attempt',
        accountMode: 'plain',
        envelope,
      })
      : openQualifiedConnectedAccountContentEnvelope({
        kind: 'attempt',
        accountMode: 'e2ee',
        material: requireConnectedAccountCryptoMaterial(
          params.credentials,
          material,
        ),
        envelope,
      });
    if (opened === null) {
      throw new Error(
        'Connected-account attempt transaction content is unavailable for the current account mode',
      );
    }
    return opened;
  }

  async function readOAuthPayload(input: Readonly<{
    attemptId: string;
    record: ConnectedAccountAttemptTransactionRecord;
  }>): Promise<OAuthPayload> {
    const opened = await open(input.record);
    const parsed = createStoredReadSchema(OAuthPayloadSchema).parse(opened);
    if (parsed.snapshot.attemptId !== input.attemptId) {
      throw new Error(
        'Connected-account OAuth transaction identity is invalid',
      );
    }
    return parsed;
  }

  async function readDevicePayload(input: Readonly<{
    attemptId: string;
    record: ConnectedAccountAttemptTransactionRecord;
  }>): Promise<DevicePayload> {
    const opened = await open(input.record);
    const parsed = createStoredReadSchema(DevicePayloadSchema).parse(opened);
    if (parsed.snapshot.attemptId !== input.attemptId) {
      throw new Error(
        'Connected-account device transaction identity is invalid',
      );
    }
    return parsed;
  }

  function createOAuthHandle(input: {
    payload: OAuthPayload;
    record: ConnectedAccountAttemptTransactionRecord;
  }): ConnectedAccountOAuthTransaction & Readonly<{
    snapshot: ConnectedAccountOAuthTransactionSnapshot;
  }> {
    let payload = input.payload;
    let record = input.record;
    let closed = false;
    return Object.freeze({
      get expiresAtMs() {
        return record.expiresAtMs;
      },
      get snapshot() {
        return payload.snapshot;
      },
      get request() {
        return Object.freeze({
          callbackUrl: payload.callbackUrl,
          state: payload.state,
          pkce: Object.freeze({
            challenge: payload.challenge,
            method: 'S256' as const,
          }),
        });
      },
      async acknowledge(snapshot) {
        if (closed) {
          throw new Error('Connected-account OAuth transaction is closed');
        }
        assertOAuthSnapshotAdvance(payload.snapshot, snapshot);
        const nextPayload = OAuthPayloadSchema.parse({
          ...payload,
          version: 2,
          snapshot,
        });
        const nextRecord = await api.replace({
          kind: 'oauth',
          attemptId: snapshot.attemptId,
          expectedRevision: record.revision,
          content: await seal(nextPayload),
          scope: scopeFor(snapshot),
          expiresAtMs: Math.min(
            record.expiresAtMs,
            snapshot.expiresAtMs ?? record.expiresAtMs,
          ),
        });
        payload = nextPayload;
        record = nextRecord;
      },
      async acceptCompletion(
        completion: ConnectedAccountOAuthCallbackCompletion,
      ) {
        if (
          closed
          || payload.consumed
          || completion.state !== payload.state
          || completion.callbackUrl !== payload.callbackUrl
        ) {
          throw new Error(
            'Connected-account OAuth completion does not match its transaction',
          );
        }
        const nextPayload = OAuthPayloadSchema.parse({
          ...payload,
          consumed: true,
        });
        const nextRecord = await api.replace({
          kind: 'oauth',
          attemptId: payload.snapshot.attemptId,
          expectedRevision: record.revision,
          content: await seal(nextPayload),
          scope: scopeFor(payload.snapshot),
          expiresAtMs: record.expiresAtMs,
        });
        payload = nextPayload;
        record = nextRecord;
        return Object.freeze({
          ...completion,
          pkceVerifier: payload.verifier,
        });
      },
      async close() {
        if (closed) return;
        await api.delete({
          kind: 'oauth',
          attemptId: payload.snapshot.attemptId,
          expectedRevision: record.revision,
        });
        closed = true;
      },
    });
  }

  const oauth: ConnectedAccountOAuthTransactionOwner = Object.freeze({
    async create(input) {
      if (
        input.attemptId !== input.snapshot.attemptId
        || !sameService(input.service, input.snapshot.service)
      ) {
        throw new Error(
          'Connected-account OAuth transaction identity is invalid',
        );
      }
      const pkce = generatePkceCodes();
      const callbackUrl = input.callbackUrl;
      const payload = OAuthPayloadSchema.parse({
        version: 2,
        kind: 'oauth',
        snapshot: input.snapshot,
        state: `${input.attemptId}.${Buffer.from(randomBytes(32)).toString('base64url')}`,
        challenge: pkce.challenge,
        verifier: pkce.verifier,
        callbackUrl,
        consumed: false,
      });
      const record = await api.create({
        kind: 'oauth',
        attemptId: input.attemptId,
        content: await seal(payload),
        scope: scopeFor(input.snapshot),
        expiresAtMs: transactionExpiresAt({
          now: now(),
          ttlMs: transactionTtlMs,
          ...(input.snapshot.expiresAtMs === undefined
            ? {}
            : { providerExpiresAtMs: input.snapshot.expiresAtMs }),
        }),
      });
      return createOAuthHandle({ payload, record });
    },
    async read(attemptId) {
      const record = await api.read({ kind: 'oauth', attemptId });
      if (!record) return null;
      const payload = await readOAuthPayload({ attemptId, record });
      return createOAuthHandle({ payload, record });
    },
  });

  return Object.freeze({
    oauth,
    async listPending(service) {
      return await api.listPending({
        machineId: params.getMachineId(),
        service,
      });
    },
    device: Object.freeze({
      async acknowledge(snapshot: ConnectedAccountDeviceTransactionSnapshot) {
        const current = await api.read({
          kind: 'device',
          attemptId: snapshot.attemptId,
        });
        const payload = DevicePayloadSchema.parse({
          version: 2,
          kind: 'device',
          snapshot,
        });
        if (!current) {
          await api.create({
            kind: 'device',
            attemptId: snapshot.attemptId,
            content: await seal(payload),
            scope: scopeFor(snapshot),
            expiresAtMs: transactionExpiresAt({
              now: now(),
              ttlMs: transactionTtlMs,
              providerExpiresAtMs: snapshot.expiresAtMs,
            }),
          });
          return;
        }
        const currentPayload = await readDevicePayload({
          attemptId: snapshot.attemptId,
          record: current,
        });
        assertDeviceSnapshotAdvance(currentPayload.snapshot, snapshot);
        await api.replace({
          kind: 'device',
          attemptId: snapshot.attemptId,
          expectedRevision: current.revision,
          content: await seal(payload),
          scope: scopeFor(snapshot),
          expiresAtMs: Math.min(current.expiresAtMs, snapshot.expiresAtMs),
        });
      },
      async read(attemptId: string) {
        const record = await api.read({ kind: 'device', attemptId });
        if (!record) return null;
        return (
          await readDevicePayload({ attemptId, record })
        ).snapshot;
      },
      async clear(attemptId: string) {
        const record = await api.read({ kind: 'device', attemptId });
        if (!record) return;
        await api.delete({
          kind: 'device',
          attemptId,
          expectedRevision: record.revision,
        });
      },
    }),
  });
}
