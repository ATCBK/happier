import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { definePluginWebhookTestFixture } from '@happier-dev/plugin-sdk/webhooks';

import * as plugin from '../fixtures/qa-plugin-authoring/qa-action-webhook/index.js';

function delivery(text: string, attempt = 1) {
    const rawBody = Buffer.from(text);
    return definePluginWebhookTestFixture({
        webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
        input: {
            v: 1,
            endpoint: {
                webhookContribution: { pluginId: 'qa.public-action-webhook', localId: 'verified-notes' },
                sourceInstanceId: 'qa:notes',
            },
            delivery: {
                deliveryId: 'qa-delivery-1', attempt, replay: 0,
                receivedAtMs: 1, providerDeliveryId: 'qa-provider-delivery-1',
            },
            request: {
                contentType: 'application/json',
                headers: [{ name: 'x-github-event', value: 'issues' }],
                rawBodyBytes: rawBody.byteLength,
                rawBodyBase64: rawBody.toString('base64'),
            },
            verified: { verifier: 'github_hmac_sha256_v1', eventType: 'issues' },
        },
        result: { kind: 'settled', disposition: 'accepted' },
    });
}

describe('QA public Action and webhook authoring', () => {
    it('normalizes the same note across human and agent invocation surfaces', async () => {
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
        try {
            for (const surface of ['cli', 'mcp', 'agent', 'ui'] as const) {
                await expect(kit.invokeAction('summarize-note', { text: '  Release review  ' }, { surface }))
                    .resolves.toEqual({ summary: 'Release review' });
            }
            await expect(kit.invokeAction('summarize-note', { text: '   ' })).rejects.toThrow();
            await expect(kit.invokeAction('summarize-note', { text: 'Ready', extra: true })).rejects.toThrow();
        } finally {
            await kit.dispose();
        }
        await expect(kit.invokeAction('summarize-note', { text: 'Ready' })).rejects.toThrow(/disposed/u);
    });

    it('settles repeated verified deliveries and dead-letters malformed domain bodies', async () => {
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
        try {
            for (const attempt of [1, 2]) {
                const fixture = delivery(JSON.stringify({ text: '  Release review  ' }), attempt);
                await expect(kit.invokeAction('receive-note', fixture.input, { surface: 'plugin' }))
                    .resolves.toEqual(fixture.result);
            }
            for (const body of ['not-json', '{"text":"   "}', '{"text":7}']) {
                await expect(kit.invokeAction('receive-note', delivery(body).input, { surface: 'plugin' }))
                    .resolves.toEqual({ kind: 'deadLetter', code: 'qa_note_invalid' });
            }
            const valid = delivery('{"text":"Ready"}').input;
            await expect(kit.invokeAction('receive-note', {
                ...valid, request: { ...valid.request, rawBodyBytes: 0 },
            }, { surface: 'plugin' })).rejects.toThrow();
            // Direct testkit invocation forwards surface context; production surface-policy proof belongs to Phase B.
        } finally {
            await kit.dispose();
        }
    });
});
