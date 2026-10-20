import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';

import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import {
  AccountEncryptionCurrentnessUnavailableError,
  fetchAccountEncryptionCurrentness,
} from '@/api/client/connectedServiceCredentialApi';
import { assertSessionEncryptionModeAllowedByEffectiveClientRequirement } from '@/settings/accountSettings/resolveEffectiveClientEncryptionRequirement';

export type DesiredSessionCreateEncryptionModeResult = Readonly<{
  desiredSessionEncryptionMode: 'e2ee' | 'plain';
  accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
  serverSupportsFeatureSnapshot: boolean;
  serverFeaturesSnapshot: CliServerFeaturesSnapshot;
  storagePolicy: 'required_e2ee' | 'optional' | 'plaintext_only';
}>;

/**
 * The preflight either resolves the Session mode or reports that the Account
 * currentness read could not be served. Client encryption-requirement
 * refusals still throw: they are decisions, not
 * transport outcomes. The caller owns the transport classification (offline
 * mode, stable auth errors) because the same transport serves its own request.
 */
export type SessionCreateEncryptionModeResolution =
  | (Readonly<{ status: 'resolved' }> & DesiredSessionCreateEncryptionModeResult)
  | Readonly<{
      status: 'currentness_unavailable';
      error: AccountEncryptionCurrentnessUnavailableError;
    }>;

export async function resolveSessionCreateEncryptionMode(params: Readonly<{
  token: string;
  serverBaseUrl: string;
  accountEncryptionCurrentness?: AccountEncryptionCurrentnessResponse;
  signal?: AbortSignal;
}>): Promise<SessionCreateEncryptionModeResolution> {
  params.signal?.throwIfAborted();
  const featuresSnapshot = await fetchServerFeaturesSnapshot({ serverUrl: params.serverBaseUrl,
    ...(params.signal ? { signal: params.signal } : {}) });
  const serverSupportsFeatureSnapshot = featuresSnapshot.status === 'ready';
  const storagePolicy: 'required_e2ee' | 'optional' | 'plaintext_only' =
    featuresSnapshot.status === 'ready'
      ? featuresSnapshot.features.capabilities.encryption.storagePolicy
      : 'required_e2ee';

  let accountEncryptionCurrentness = params.accountEncryptionCurrentness;
  if (!accountEncryptionCurrentness) {
    try {
      accountEncryptionCurrentness = await fetchAccountEncryptionCurrentness({
        token: params.token,
        serverBaseUrl: params.serverBaseUrl,
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (error) {
      params.signal?.throwIfAborted();
      if (error instanceof AccountEncryptionCurrentnessUnavailableError) {
        return { status: 'currentness_unavailable', error };
      }
      throw error;
    }
  }
  const desiredSessionEncryptionMode = storagePolicy === 'plaintext_only'
    ? 'plain'
    : storagePolicy === 'optional'
      ? accountEncryptionCurrentness.mode
      : 'e2ee';
  assertSessionEncryptionModeAllowedByEffectiveClientRequirement(desiredSessionEncryptionMode);
  return {
    status: 'resolved',
    desiredSessionEncryptionMode,
    accountEncryptionCurrentness,
    serverSupportsFeatureSnapshot,
    serverFeaturesSnapshot: featuresSnapshot,
    storagePolicy,
  };
}
