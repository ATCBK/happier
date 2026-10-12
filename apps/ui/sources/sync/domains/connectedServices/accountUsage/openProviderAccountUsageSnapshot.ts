import { openProviderAccountUsageEncryptedContentV4, openSealedProviderAccountUsageSnapshot, type SealedProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol/connect/accountUsage';
import type { ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol/connect/account-usage-primitives';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '../resolveAccountScopedCryptoMaterialFromCredentials';

export function openProviderAccountUsageSnapshot(
    credentials: AuthCredentials,
    content:
        | SealedProviderAccountUsageSnapshotV1
        | Parameters<typeof openProviderAccountUsageEncryptedContentV4>[0]['content'],
): ProviderAccountUsageSnapshotV1 | null {
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
    if ('t' in content) {
        return openProviderAccountUsageEncryptedContentV4({ material, content });
    }
    return openSealedProviderAccountUsageSnapshot({ material, sealed: content });
}
