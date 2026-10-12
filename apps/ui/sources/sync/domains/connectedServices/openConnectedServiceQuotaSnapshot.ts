import type { ConnectedServiceQuotaSnapshotV1, SealedConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { openConnectedServiceQuotaSnapshotCiphertext } from '@happier-dev/protocol/connect/connectedServiceCipher';
import { BuiltInLegacyConnectedServiceCompatibilityError, parseBuiltInLegacyConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAccountScopedCryptoMaterialFromCredentials } from './resolveAccountScopedCryptoMaterialFromCredentials';

export function openConnectedServiceQuotaSnapshot(
  credentials: AuthCredentials,
  sealed: SealedConnectedServiceQuotaSnapshotV1,
): ConnectedServiceQuotaSnapshotV1 | null {
  const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);

  const opened = openConnectedServiceQuotaSnapshotCiphertext({ material, ciphertext: sealed.ciphertext });
  if (!opened || !opened.value) return null;

  try {
    return parseBuiltInLegacyConnectedServiceQuotaSnapshotV1(opened.value);
  } catch (error) {
    if (error instanceof BuiltInLegacyConnectedServiceCompatibilityError) return null;
    throw error;
  }
}
