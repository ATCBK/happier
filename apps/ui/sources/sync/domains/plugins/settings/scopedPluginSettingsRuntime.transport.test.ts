import { describe, expect, it } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installDisconnectedServerSocketBoundary();

describe('Account plugin Settings HTTP issue admission', () => {
    it.each(['field-retired', 'account-retired', 'current'] as const)(
        'checks the existing intent after encryption preparation: %s', async disposition => {
            const bridge = await loadSyncSingletonForTests();
            const mode = createDeferred<Response>();
            const preparingWrite = createDeferred<void>();
            const posts: unknown[] = [];
            let recordRead = false;
            let intentCurrent = true;
            const connection = await restoreServerAccountForTest({
                serverUrl: 'https://plugin-settings-issue.test', serverIdentityId: 'srv_settings_issue', accountId: 'account-a',
                request: async (url, init) => {
                    const path = new URL(String(url)).pathname;
                    if (path === '/v1/account/encryption') {
                        if (recordRead) { preparingWrite.resolve(); return mode.promise; }
                        return Response.json({ mode: 'plain', updatedAt: 1 });
                    }
                    if (path === '/v1/account/plugin-settings/acme.settings') {
                        if (init?.method === 'POST') {
                            posts.push(JSON.parse(String(init.body)));
                            return Response.json({ status: 'updated', revision: 1 });
                        }
                        recordRead = true;
                        return Response.json({ status: 'absent' });
                    }
                    return null;
                },
            });
            try {
                const { scopedPluginSettingsStorageAdapterForTests: scopedPluginSettingsAdapter } = await import('./scopedPluginSettingsRuntime');
                const write = scopedPluginSettingsAdapter.write({
                    pluginId: 'acme.settings', scope: { kind: 'account' },
                    target: { kind: 'account', serverIdentityId: 'srv_settings_issue' },
                    fields: [{ key: 'endpoint', redacted: false }], fieldId: 'endpoint',
                    mutation: { kind: 'set', value: 'https://endpoint.test' },
                    expectedRevision: { kind: 'account', value: 'absent' }, isCurrent: () => intentCurrent,
                });
                await preparingWrite.promise;
                if (disposition === 'field-retired') intentCurrent = false;
                if (disposition === 'account-retired') {
                    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
                    await disconnectActiveServerConnection();
                }
                mode.resolve(Response.json({ mode: 'plain', updatedAt: 1 }));
                const result = await write;
                if (disposition === 'current') {
                    expect(result.status).toBe('ready');
                    expect(posts).toEqual([{ expectedRevision: 'absent', content: {
                        t: 'plain', v: { v: 1, values: { endpoint: 'https://endpoint.test' } },
                    } }]);
                } else {
                    expect(posts).toEqual([]);
                    expect(result).toEqual({ status: 'unavailable', reason: 'transport' });
                }
            } finally { mode.resolve(Response.json({ mode: 'plain', updatedAt: 1 })); await connection.dispose(); bridge.dispose(); }
        },
    );
});
