import { describe, expect, it } from 'vitest';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { openSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import { fetchAccountEncryptionSessionFollowRulesMigrationCandidates } from './fetchAccountEncryptionSessionFollowRulesMigrationCandidates';
import { buildAccountEncryptionSessionFollowRulesDirective } from './buildAccountEncryptionSessionFollowRulesDirective';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';

const definition = { v: 1 as const, enabled: true, policy: { preset: 'important' as const },
    filter: normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' }) };
const row = { ruleId: 'payments', receiver: { kind: 'account' as const }, version: 3, content: { t: 'plain' as const, v: definition } };
const credentials = { token: 'token', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };

describe('Account mode transition Follow rule census', () => {
    it('opens the exact remote census keylessly, reseals both ways, and preserves identity and revision', async () => {
        const captured = await fetchAccountEncryptionSessionFollowRulesMigrationCandidates({ credentials: { token: 'plain' }, mode: 'plain',
            request: async path => { expect(path).toBe('/v2/account/session-follow-rules'); return Response.json({ rules: [row] }); }, assertCurrent() {},
        });
        const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
        const encrypted = buildAccountEncryptionSessionFollowRulesDirective({ candidates: captured,
            target: { mode: 'e2ee', material, randomBytes: length => new Uint8Array(length).fill(7) } });
        const item = encrypted!.items[0]!;
        expect(item).toMatchObject({ ruleId: row.ruleId, receiver: row.receiver, expectedVersion: 3, content: { t: 'encrypted' } });
        expect(openSessionFollowRuleContentV1({ ...item, mode: 'e2ee', material })).toEqual({ status: 'opened', definition });
        const opened = await fetchAccountEncryptionSessionFollowRulesMigrationCandidates({ credentials, mode: 'e2ee',
            request: async () => Response.json({ rules: [{ ...row, content: item.content }] }), assertCurrent() {},
        });
        expect(buildAccountEncryptionSessionFollowRulesDirective({ candidates: opened, target: { mode: 'plain' } }))
            .toEqual({ items: [{ ruleId: row.ruleId, receiver: row.receiver, expectedVersion: 3, content: row.content }] });
    });

    it('refuses mixed-mode, failed and retired censuses instead of treating them as no rules', async () => {
        for (const response of [Response.json({ rules: [{ ...row, content: { t: 'encrypted', c: 'wrong-mode' } }] }), new Response(null, { status: 403 })]) {
            await expect(fetchAccountEncryptionSessionFollowRulesMigrationCandidates({ credentials: { token: 'plain' }, mode: 'plain',
                request: async () => response, assertCurrent() {},
            })).rejects.toThrow();
        }
        let current = true;
        await expect(fetchAccountEncryptionSessionFollowRulesMigrationCandidates({ credentials: { token: 'plain' }, mode: 'plain',
            request: async () => { current = false; return Response.json({ rules: [row] }); },
            assertCurrent() { if (!current) throw new Error('retired'); },
        })).rejects.toThrow('retired');
    });
});
