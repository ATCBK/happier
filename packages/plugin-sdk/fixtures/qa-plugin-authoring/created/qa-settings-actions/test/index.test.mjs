import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as module from '../dist/index.js';

test('each setting Action writes the declared Account service for UI and agent callers', async () => {
    // Host Settings is the external boundary; no Account, credentials or database are used.
    const values = { enabled: true, style: 'concise', unrelated: 'retain' };
    const scope = { kind: 'account' };
    let revision = 0;
    const settings = {
        forScope(request) {
            assert.deepEqual(request, scope);
            return {
                async set(id, value, options) {
                    options?.signal?.throwIfAborted();
                    values[id] = value; revision += 1;
                    return { scope, revision: String(revision) };
                },
            };
        },
    };
    const plugin = await createPluginTestkit({ manifest: module.manifest, module, services: { settings } });
    try {
        for (const surface of ['ui', 'agent', 'cli', 'mcp']) {
            await plugin.invokeAction('reminders-set', { enabled: false }, { surface });
            assert.equal(values.enabled, false);
            await plugin.invokeAction('summary-style-set', { style: 'detailed' }, { surface });
            assert.equal(values.style, 'detailed');
        }
        assert.equal(values.unrelated, 'retain');
        await assert.rejects(plugin.invokeAction('reminders-set', { enabled: 'yes' }));
        await assert.rejects(plugin.invokeAction('summary-style-set', { style: 'invented' }));
        const controller = new AbortController(); controller.abort();
        await assert.rejects(plugin.invokeAction('reminders-set', { enabled: true }, { signal: controller.signal }));
        assert.equal(values.enabled, false);
    } finally { await plugin.dispose(); }
});

test('settings are unavailable without an explicit host boundary', async () => {
    const plugin = await createPluginTestkit({ manifest: module.manifest, module });
    try { await assert.rejects(plugin.invokeAction('reminders-set', { enabled: false })); }
    finally { await plugin.dispose(); }
});
