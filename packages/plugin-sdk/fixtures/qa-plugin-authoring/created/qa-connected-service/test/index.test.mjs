import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as plugin from '../dist/index.js';

test('connects a fake QA credential through the admitted public author build', async () => {
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
    try {
        const runtime = kit.registration('connectedAccountDescriptors', 'demo');
        assert.ok(runtime);
        assert.equal(plugin.manifest.contributes.connectedAccountDescriptors[0].title, 'QA Demo service');
        const values = new Map();
        const credentials = {
            async get(key) { return values.get(key) ?? null; },
            async set(key, value) { values.set(key, value); },
            async delete(key) { values.delete(key); },
        };
        const service = { pluginId: plugin.manifest.id, localId: 'demo' };
        const context = {
            signal: new AbortController().signal,
            service,
            attempt: { kind: 'connect', attemptId: 'qa-attempt-1' },
            configuration: { target: { kind: 'attempt', attemptId: 'qa-attempt-1', service, modeId: 'manual' },
                revision: 'qa-config-1', values: {}, async getSecret() { return null; } },
            attemptCredentials: credentials,
        };
        assert.deepEqual(await runtime.authentication.modes.manual.complete({ fields: { token: 'qa-demo-token' } }, context),
            { status: 'connected', displayName: 'QA Demo account', scopes: [] });
        assert.equal((await runtime.status({ credentials })).status, 'connected');
    } finally {
        await kit.dispose();
    }
});
