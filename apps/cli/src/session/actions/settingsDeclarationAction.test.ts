import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliSettingsDeclarationAction } from './settingsDeclarationAction';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol';

afterEach(() => vi.restoreAllMocks());

describe('headless settings conditional writes', () => {
    it('refuses a read-only reset before reading or writing Account material', async () => {
        const read = vi.spyOn(axios, 'get');
        const write = vi.spyOn(axios, 'post');
        const action = createCliSettingsDeclarationAction({});
        expect(await action({ actionId: 'settings.reset', input: { anchor: 'language.appLanguage' },
            context: { surface: 'cli' } })).toMatchObject({ ok: false, errorCode: 'setting_read_only' });
        expect(read).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });

    it.each(['settings.workflowRuns.maxActiveRunsPerMachine', 'notifications.autoFollowAssigned'])
        ('keeps non-Account reset unsupported for %s without borrowing an owner', async anchor => {
            const read = vi.spyOn(axios, 'get');
            const write = vi.spyOn(axios, 'post');
            const action = createCliSettingsDeclarationAction({});
            expect(await action({ actionId: 'settings.reset', input: { anchor }, context: { surface: 'cli' } }))
                .toMatchObject({ ok: false, errorCode: 'setting_reset_unsupported' });
            expect(read).not.toHaveBeenCalled();
            expect(write).not.toHaveBeenCalled();
        });

    it.each([
        { actionId: 'settings.get', input: { anchor: 'delegation.workDepthLimit', includeVersion: true } },
        { actionId: 'settings.set', input: { anchor: 'delegation.workDepthLimit', value: 2, expectedSettingsVersion: 4 } },
        { actionId: 'settings.set', input: { anchor: 'delegation.workDepthLimit', value: 2, reversal: { kind: 'capture' } } },
    ] as const)('requires Account credentials for versioned reads, CAS and exact reversal', async request => {
        const action = createCliSettingsDeclarationAction({});
        expect(await action({ ...request, context: { surface: 'agent' } }))
            .toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    });
    it('never borrows daemon credentials for an external conditional preference read', async () => {
        const read = vi.spyOn(axios, 'get');
        const write = vi.spyOn(axios, 'post');
        const action = createCliSettingsDeclarationAction({ credentials: { token: 'daemon', encryption: null } });
        expect(await action({ actionId: 'settings.get', input: { anchor: 'usage.coachPreferences', includeVersion: true },
            context: { surface: 'agent', externalActionCredential: { accountId: 'account', principalId: 'principal',
                credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 } } }))
            .toMatchObject({ ok: false, errorCode: 'requester_account_material_unavailable' });
        expect(read).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });
});
