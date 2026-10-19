import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])('binds the authenticated portable Home instead of the local profile (refreshing credentials: %s)', async (refreshing) => {
    // The three identities below are the observed X1b CLI, Home and Account ids.
    const serverId = 'stack_agent-qa-widgets-dnd__id_default';
    const serverIdentityId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const accountId = '5e3a0581-6f3d-4e73-bf40-383db0be6c3e';
    const serverApiUrl = 'https://x1b-home.example.test';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId,
        provenance: { v: 2, kind: 'terminal', authority: 'account_automation', evidence: [{ kind: 'home_method', methodId: 'key_challenge' }] },
    })).toString('base64url')}.signature`, encryption: null, credentialProvenance: 'stored_session' as const };
    // HTTP is the boundary; the feature reader, both executors and widget owners remain real.
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0]) => {
        expect(String(input)).toBe(`${serverApiUrl}/v1/features/authenticated`);
        return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId } } }));
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path.startsWith('/v1/artifacts/')) return { status: 404, data: { error: 'not_found' } };
        throw new Error(`Unexpected widget HTTP read ${path}`);
    });
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId, serverApiUrl,
        machineId: 'a40555f6-40db-4213-bc9c-fccbfa2c95b9', ...(refreshing ? { readCredentials: async () => credentials } : {}),
        pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
    const surface = { serverId: serverIdentityId, accountId,
        owner: { kind: 'project' as const, projectId: '19f0ce83-a5da-4ad5-ad66-00b566c75734', layoutId: 'qag-cli' } };
    const context = { surface: 'cli' as const, authority: 'account_automation' as const };
    // An explicit named Project layout is absent at the HTTP boundary. The
    // owning reader reports not-found only after Home/Account scope admission.
    expect(await executor.execute('widgets.item.list', { surface }, context))
        .toEqual({ ok: false, errorCode: 'widget_area_not_found', error: 'widget_area_not_found' });
    expect(await executor.execute('widgets.item.list', { surface: { ...surface, serverId: 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }, context))
        .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(await executor.execute('widgets.item.list', { surface: { ...surface, accountId: '00000000-0000-4000-8000-000000000000' } }, context))
        .toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
    const foreignHome = 'srv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(await executor.execute('widgets.item.list', { surface: { ...surface, serverId: foreignHome } },
        { ...context, serverIdentityId: foreignHome }))
        .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
});
