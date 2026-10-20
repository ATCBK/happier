import { describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { jiraAccountRuntime } from './connect.js';

describe('Jira Connected Account runtime', () => {
    it('verifies the API token on its configured site before storing it in the host credential store', async () => {
        const set = vi.fn(async () => {});
        const request = vi.fn(async () => ({ status: 200, headers: {}, finalUrl: 'https://work.atlassian.net/rest/api/3/myself',
            body: new TextEncoder().encode(JSON.stringify({ accountId: 'person-1', displayName: 'Amina' })) }));
        // Credential store and HTTP are genuine host boundaries.
        const context = { signal: new AbortController().signal, configuration: { values: { site: 'https://work.atlassian.net' } },
            attemptCredentials: { set }, services: { http: { request } },
        } as unknown as ConnectedAccountAuthenticationContext;
        const mode = jiraAccountRuntime.authentication.modes['api-token'];
        if (mode?.kind !== 'manual') throw new Error('manual API-token mode is required');
        expect(await mode.complete({ fields: { email: 'amina@example.test', token: 'fixture-only' } }, context)).toMatchObject({ status: 'connected' });
        expect(set).toHaveBeenCalledWith('token', 'fixture-only', undefined);
        expect(request.mock.calls[0]).toBeDefined();
    });

    it('materializes Basic authorization only for the configured site and refuses another origin', async () => {
        const context = { configuration: { values: { site: 'https://work.atlassian.net' } },
            credentials: { get: async (key: string) => key === 'email' ? 'amina@example.test' : 'fixture-only' },
        } as unknown as ConnectedAccountReadContext;
        const material = await jiraAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://work.atlassian.net', headerNames: ['authorization'] }, context);
        expect(material).toEqual({ kind: 'httpHeaders', headers: { authorization: `Basic ${Buffer.from('amina@example.test:fixture-only').toString('base64')}` } });
        await expect(jiraAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://other.atlassian.net', headerNames: ['authorization'] }, context)).rejects.toThrow();
    });
});
