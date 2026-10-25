import { describe, expect, it } from 'vitest';
import { TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';

import { readTeamCredentialSourceBinding } from './sourceBindingRead';

describe('stored Team credential source binding', () => {
    const source = TeamCredentialSourceBindingV1Schema.parse({
        v: 1, kind: 'provider_connection', connectionId: 'stored-provider',
        connectionSecurityFingerprint: 'connection-security:v1:stored-provider', credentialSlotId: 'apiKey',
    });

    it('reads the canonical producer shape and preserves the distinction between malformed JSON and invalid identity', () => {
        expect(readTeamCredentialSourceBinding(JSON.stringify(source))).toEqual({ success: true, data: source });
        expect(readTeamCredentialSourceBinding('{')).toEqual({ success: false, reason: 'invalid_json' });
        expect(readTeamCredentialSourceBinding(JSON.stringify({ ...source, credentialSlotId: '' })))
            .toEqual({ success: false, reason: 'invalid_binding' });
    });

    it('projects unknown stored fields without admitting them as request authority', () => {
        const stored = { ...source, retiredDisplay: { label: 'old annotation' } };
        expect(TeamCredentialSourceBindingV1Schema.safeParse(stored).success).toBe(false);
        expect(readTeamCredentialSourceBinding(JSON.stringify(stored))).toEqual({ success: true, data: source });
    });
});
