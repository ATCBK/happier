import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sealSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import { AccountEncryptionMigrateSessionFollowRulesDirectiveV1Schema,
    type AccountEncryptionMigrateSessionFollowRulesDirectiveV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import type { OpenedSessionFollowRule } from '@/sync/api/session/sessionFollowRulesApi';

export function buildAccountEncryptionSessionFollowRulesDirective(params: Readonly<{
    candidates: readonly OpenedSessionFollowRule[];
    target: Readonly<{ mode: 'plain' }> | Readonly<{
        mode: 'e2ee'; material: AccountScopedCryptoMaterial; randomBytes(length: number): Uint8Array;
    }>;
}>): AccountEncryptionMigrateSessionFollowRulesDirectiveV1 | undefined {
    if (params.candidates.length === 0) return undefined;
    return AccountEncryptionMigrateSessionFollowRulesDirectiveV1Schema.parse({ items: params.candidates.map(rule => ({
        ruleId: rule.ruleId, receiver: rule.receiver, expectedVersion: rule.version,
        content: sealSessionFollowRuleContentV1({ ...rule, mode: params.target.mode,
            material: params.target.mode === 'plain' ? null : params.target.material,
            ...(params.target.mode === 'plain' ? {} : { randomBytes: params.target.randomBytes }),
        }),
    })) });
}
