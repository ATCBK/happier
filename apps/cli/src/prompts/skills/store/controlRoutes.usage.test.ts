import { expect, it } from 'vitest';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createSkillUsageRecorder } from './skillUsage';

it('admits skill use only through the authenticated strict daemon route', async () => {
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine',
        stopSession: async () => ({ status: 'not_found' }),
        spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'control-secret',
        skillUsageRecorder: createSkillUsageRecorder({ credentials: { token: 'unavailable-fixture-account', encryption: null } }) });
    const payload = { skillIds: ['delivered-guide'], account: {
        accountId: 'unavailable-fixture-account', serverHttpBaseUrl: 'https://home.example.invalid' } };
    const headers = { 'x-happier-daemon-token': 'control-secret' };
    try {
        expect((await app.inject({ method: 'POST', url: '/skills/usage', payload })).statusCode).toBe(401);
        expect((await app.inject({ method: 'POST', url: '/skills/usage', headers, payload: { ...payload, accountId: 'other' } })).statusCode).toBe(400);
        expect((await app.inject({ method: 'POST', url: '/skills/usage', headers,
            payload: { ...payload, account: { accountId: 'other' } } })).statusCode).toBe(400);
        const recorded = await app.inject({ method: 'POST', url: '/skills/usage', headers, payload });
        expect(recorded.statusCode).toBe(200);
        expect(recorded.json()).toEqual({ ok: true });
    } finally { await app.close(); }
});
