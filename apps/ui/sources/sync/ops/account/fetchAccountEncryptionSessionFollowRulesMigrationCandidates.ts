import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { readSessionFollowRuleCensus, type OpenedSessionFollowRule } from '@/sync/api/session/sessionFollowRulesApi';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';

export function fetchAccountEncryptionSessionFollowRulesMigrationCandidates(params: Readonly<{
    credentials: AuthCredentials;
    mode: 'plain' | 'e2ee';
    request(path: string, init?: RequestInit): Promise<Response>;
    assertCurrent(): void;
}>): Promise<readonly OpenedSessionFollowRule[]> {
    return readSessionFollowRuleCensus({ ...params,
        material: params.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(params.credentials),
    });
}
