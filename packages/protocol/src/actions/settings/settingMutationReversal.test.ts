import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { AccountSettingMutationV1Schema, applyAccountSettingMutationV1 } from '../../account/settings/accountSettingMutationV1.js';
import { SettingsDeclarationMutationReversalV1Schema } from '../settingsDeclarationActionFamily.js';
import { scmGitRoutingStorage } from './accountSettingBindings.js';
import { captureSettingMutationV1, restoreSettingMutationV1 } from './settingMutationReversal.js';

describe('bound setting mutation receipts', () => {
    it('does not disclose a nested SecretString through an otherwise readable object setting receipt', () => {
        const voice = { enabled: false, retained: { apiKey: { _isSecretValue: true, value: 'test-only-secret' } } };
        const mutation = AccountSettingMutationV1Schema.parse({ operations: [{ op: 'set', key: 'voice', value: { ...voice, enabled: true } }] });
        expect(captureSettingMutationV1({ voice }, mutation)).toBeNull();
        const clean = AccountSettingMutationV1Schema.parse({ operations: [{ op: 'set', key: 'voice', value: { enabled: true } }] });
        expect(captureSettingMutationV1({}, clean, { voice })).toBeNull();
        const receipt = SettingsDeclarationMutationReversalV1Schema.parse({ scope: { serverId: 'home', accountId: 'account' },
            beforeVersion: 1, appliedVersion: 2, before: { value: voice }, applied: { value: { ...voice, enabled: true } } });
        expect(restoreSettingMutationV1({ voice: { ...voice, enabled: true } }, mutation, receipt)).toEqual({ status: 'invalid' });
    });
    it('restores the real compound producer across unrelated changes and rejects affected-key drift or substituted keys', () => {
        const baseline = { favoriteMachines: ['original'] };
        const delta = scmGitRoutingStorage.mutate(accountSettingsParse(baseline), 'happier.scm.backend.sapling/sapling');
        if (!delta) throw new Error('Routing intent must be admitted');
        const mutation = AccountSettingMutationV1Schema.parse({ operations: Object.entries(delta).map(([key, value]) => ({ op: 'set', key, value })) });
        const captured = captureSettingMutationV1(baseline, mutation);
        expect(captured).not.toBeNull();
        const receipt = SettingsDeclarationMutationReversalV1Schema.parse({ scope: { serverId: 'home', accountId: 'account' },
            beforeVersion: 1, appliedVersion: 2, ...captured });
        const applied = applyAccountSettingMutationV1(baseline, mutation);
        if (applied.status === 'invalid') throw new Error(applied.reason);
        const concurrent = { ...applied.raw, favoriteMachines: ['concurrent'] };
        const restore = restoreSettingMutationV1(concurrent, mutation, receipt);
        expect(restore.status).toBe('prepared');
        if (restore.status !== 'prepared') throw new Error('Expected restore');
        expect(applyAccountSettingMutationV1(concurrent, restore.mutation)).toMatchObject({ status: 'applied', raw: { favoriteMachines: ['concurrent'] } });
        const first = mutation.operations[0];
        if (!first || !('changes' in receipt)) throw new Error('Expected compound receipt');
        expect(restoreSettingMutationV1({ ...concurrent, [first.key]: 'different' }, mutation, receipt)).toEqual({ status: 'conflict' });
        const substituted = { ...receipt, changes: receipt.changes.map((change, index) => index === 0
            ? { key: 'favoriteMachines', before: { value: ['unwanted'] }, applied: { value: ['concurrent'] } } : change) };
        expect(restoreSettingMutationV1(concurrent, mutation, SettingsDeclarationMutationReversalV1Schema.parse(substituted)))
            .toEqual({ status: 'invalid' });
    });
});
