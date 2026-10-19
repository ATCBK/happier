import { hexToBytes } from '@noble/hashes/utils';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { verifyAccountContentKeyBindingV1 } from '../crypto/accountContentKeyBindingV1.js';
import { sealEncryptedDataKeyEnvelopeV1 } from '../crypto/encryptedDataKeyEnvelopeV1.js';
import type { ResourceAccessRecipientCensusV1, ResourceRecipientCensusRowV1,
  ResourceRecipientKeyEnvelopeInputV1, ResourceRecipientKeyEnvelopeCommitInputV1,
  ResourceRecipientKeyEnvelopeCommitResponseV1 } from './resourceGrantAccessV1.js';

/** Verify once before resource-specific key channels are prepared. This never grants access. */
export function prepareVerifiedResourceRecipientEnvelopesV1<Recipient extends ResourceRecipientCensusRowV1, Keys extends { encryptedDataKey: string }>(
  params: Readonly<{ recipients: readonly Recipient[]; randomBytes: (length: number) => Uint8Array; replaceExisting?: boolean }>,
  prepare: (recipient: Recipient, current: boolean, seal: (dataKey: Uint8Array) => string) => Keys | null,
): (Keys & Pick<ResourceRecipientKeyEnvelopeInputV1, 'recipientAccountId' | 'recipientContentPublicKeyFingerprint'>)[] {
  const prepared: (Keys & Pick<ResourceRecipientKeyEnvelopeInputV1, 'recipientAccountId' | 'recipientContentPublicKeyFingerprint'>)[] = [];
  for (const recipient of params.recipients) {
    if (recipient.contentKey.status !== 'available') continue;
    let verified: ReturnType<typeof verifyAccountContentKeyBindingV1>;
    try {
      verified = verifyAccountContentKeyBindingV1({
        accountSigningPublicKey: hexToBytes(recipient.contentKey.accountSigningPublicKey),
        contentPublicKey: decodeBase64(recipient.contentKey.contentPublicKey),
        signature: decodeBase64(recipient.contentKey.contentPublicKeySignature),
      });
    } catch { continue; }
    if (!verified || verified.contentPublicKeyFingerprint !== recipient.contentPublicKeyFingerprint) continue;
    const current = !params.replaceExisting && recipient.recipientContentPublicKeyFingerprint === verified.contentPublicKeyFingerprint;
    const binding = verified;
    const keys = prepare(recipient, current, dataKey => encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey, recipientPublicKey: binding.contentPublicKey, randomBytes: params.randomBytes,
    })));
    if (keys) prepared.push({ ...keys, recipientAccountId: recipient.recipientAccountId,
      recipientContentPublicKeyFingerprint: verified.contentPublicKeyFingerprint });
  }
  return prepared;
}

export function prepareResourceRecipientKeyEnvelopesV1(params: Readonly<{
  dataKey: Uint8Array; recipients: readonly ResourceRecipientCensusRowV1[];
  randomBytes: (length: number) => Uint8Array; replaceExisting?: boolean;
}>): ResourceRecipientKeyEnvelopeInputV1[] {
  return prepareVerifiedResourceRecipientEnvelopesV1(params, (recipient, current, seal) =>
    current && recipient.encryptedDataKey ? null : { encryptedDataKey: seal(params.dataKey) });
}

/** Resource address validation and additional key channels remain in the resource adapter. */
export async function runResourceRecipientKeyPreparationV1<Census extends ResourceAccessRecipientCensusV1>(params: Readonly<{
  dataKey: Uint8Array | null;
  openedDataEncryptionKey: string | null;
  randomBytes: (length: number) => Uint8Array;
  readCensus: () => Promise<Census>;
  validateIdentity: (census: Census) => void;
  dataKeyChangedError?: () => Error;
  prepare?: (input: Readonly<{ dataKey: Uint8Array; recipients: readonly ResourceRecipientCensusRowV1[] }>, census: Census) => ResourceRecipientKeyEnvelopeInputV1[];
  commit: (input: ResourceRecipientKeyEnvelopeCommitInputV1, census: Census) => Promise<ResourceRecipientKeyEnvelopeCommitResponseV1>;
  signal?: AbortSignal;
}>): Promise<ResourceRecipientKeyEnvelopeCommitResponseV1> {
  params.signal?.throwIfAborted();
  const census = await params.readCensus();
  params.signal?.throwIfAborted();
  params.validateIdentity(census);
  const empty = { appliedRecipientAccountIds: [], skippedRecipientAccountIds: [] };
  if (census.encryptionMode === 'plain' || !params.dataKey) return empty;
  if (!census.dataEncryptionKey || !census.callerDataEncryptionKey
    || census.callerDataEncryptionKey !== params.openedDataEncryptionKey) {
    throw params.dataKeyChangedError?.() ?? Object.assign(new Error('resource_data_key_changed'), { code: 'resource_data_key_changed' });
  }
  const input = { dataKey: params.dataKey, recipients: census.recipients.filter(recipient => recipient.recipientAccountId !== census.ownerAccountId) };
  const recipientKeyEnvelopes = params.prepare ? params.prepare(input, census)
    : prepareResourceRecipientKeyEnvelopesV1({ ...input, randomBytes: params.randomBytes });
  if (!recipientKeyEnvelopes.length) return empty;
  params.signal?.throwIfAborted();
  return params.commit({ expectedDataEncryptionKey: census.dataEncryptionKey, recipientKeyEnvelopes }, census);
}
