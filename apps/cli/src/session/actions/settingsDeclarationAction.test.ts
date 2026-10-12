import { describe, expect, it } from 'vitest';
import { createCliSettingsDeclarationAction } from './settingsDeclarationAction';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol';

describe('headless settings conditional writes', () => {
    it('routes catalog-dependent atmosphere and private Project settings to an answering client', async () => {
        const action = createCliSettingsDeclarationAction({});
        for (const anchor of ['appearance.homeAtmosphere', 'appearance.atmosphereLooks', 'appearance.projectAtmosphere']) {
            expect(await action({ actionId: 'settings.get', input: { anchor,
                ...(anchor === 'appearance.projectAtmosphere' ? { target: { kind: 'project', serverId: 'home-a', projectKey: 'project-a' } } : {}) },
                context: { surface: 'agent', serverId: 'home-a' } })).toMatchObject({ ok: false, errorCode: 'unavailable',
                    details: { reason: 'client_unavailable', recovery: { kind: 'connect_client' } } });
        }
    });
    it.each([
        { actionId: 'settings.get', input: { anchor: 'delegation.workDepthLimit', includeVersion: true } },
        { actionId: 'settings.set', input: { anchor: 'delegation.workDepthLimit', value: 2, expectedSettingsVersion: 4 } },
        { actionId: 'settings.set', input: { anchor: 'delegation.workDepthLimit', value: 2, reversal: { kind: 'capture' } } },
    ] as const)('requires Account credentials before the headless conditional owner can read or mutate', async request => {
        const action = createCliSettingsDeclarationAction({});
        expect(await action({ ...request, context: { surface: 'agent' } }))
            .toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    });
    it('never borrows daemon credentials for an external conditional preference read', async () => {
        const action = createCliSettingsDeclarationAction({ credentials: { token: 'daemon', encryption: null } });
        expect(await action({ actionId: 'settings.get', input: { anchor: 'usage.coachPreferences', includeVersion: true },
            context: { surface: 'agent', externalActionCredential: { accountId: 'account', principalId: 'principal',
                credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 } } }))
            .toMatchObject({ ok: false, errorCode: 'requester_account_material_unavailable' });
    });
});
