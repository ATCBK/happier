import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as plugin from '../dist/index.js';

test('runs the QA note Action from the public author build', async () => {
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
    try {
        assert.deepEqual({ ...await kit.invokeAction('summarize-note', { text: '  Release review  ' }) },
            { summary: 'Release review' });
        await assert.rejects(kit.invokeAction('summarize-note', { text: '   ' }));
    } finally {
        await kit.dispose();
    }
});
