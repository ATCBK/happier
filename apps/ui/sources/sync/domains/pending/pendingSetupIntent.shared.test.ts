import { describe, expect, it } from 'vitest';
import { fromRecord, toRecord } from './pendingSetupIntent.shared';

describe('stored pending setup intent', () => {
    it('restores stored UI context while input admission stays strict', () => {
        const currentUiContext = { navigation: { area: 'settings', screen: 'plugins', retired: true }, commands: [], retired: true };
        const intent = { branch: 'askHappier' as const, phase: 'post_auth' as const, relayUrl: null, currentUiContext };
        expect(fromRecord({ ...intent, createdAtMs: Date.now() })).toEqual({ branch: 'askHappier', phase: 'post_auth', relayUrl: null,
            currentUiContext: { navigation: { area: 'settings', screen: 'plugins' }, commands: [] } });
        expect(toRecord(intent)).toBeNull();
    });
});
