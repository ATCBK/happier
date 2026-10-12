import { describe, expect, it } from 'vitest';

import { providerModelConnectionTitle } from './providerModelConnectionTitle';

describe('providerModelConnectionTitle', () => {
    it('uses the provider identity for an automatic default even with a stale connection display name', () => {
        expect(providerModelConnectionTitle({ providerName: 'OpenRouter', connectionName: 'Old display name',
            connectionRole: 'default', connectionDisplayNameMode: 'automatic' })).toBe('OpenRouter');
    });
    it('names a connection once when its name is the provider name', () => {
        expect(providerModelConnectionTitle({
            providerName: 'QA custom live', connectionName: ' qa custom live ',
            connectionRole: 'named', connectionDisplayNameMode: 'custom',
        })).toBe('QA custom live');
    });

    it('keeps the connection beside its provider when the names differ', () => {
        expect(providerModelConnectionTitle({
            providerName: 'OpenRouter', connectionName: 'Work',
            connectionRole: 'named', connectionDisplayNameMode: 'custom',
        })).toBe('OpenRouter · Work');
    });
});
