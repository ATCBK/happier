import { definePlugin } from '@happier-dev/plugin-sdk';
import {
    decodePluginWebhookActionRawBody,
    PluginWebhookActionInputSchema,
    PluginWebhookActionResultSchema,
} from '@happier-dev/plugin-sdk/webhooks';

import { summarizeNote } from './note.js';

// Adapted from the maintained public-authoring package root and webhook guide.
// Endpoint, verifier, delivery custody and retries belong to the host.
export const { manifest, activate } = definePlugin({
    id: 'qa.public-action-webhook',
    version: '0.1.0',
    displayName: 'QA Action and webhook',
    description: 'QA-only public authoring fixture; not shipped.',
    entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },
    actions: {
        'summarize-note': {
            title: 'Summarize QA note',
            scopes: ['global'], surfaces: ['ui', 'agent', 'cli', 'mcp'],
            execution: { target: 'daemon' }, dangerLevel: 'safe',
            inputSchema: {
                type: 'object', additionalProperties: false, required: ['text'],
                properties: { text: { type: 'string', minLength: 1 } },
            },
            resultSchema: {
                type: 'object', additionalProperties: false, required: ['summary'],
                properties: { summary: { type: 'string', minLength: 1 } },
            },
            async run(input) { return summarizeNote(input); },
        },
        'receive-note': {
            title: 'Receive verified QA note',
            surfaces: ['plugin'], execution: { target: 'daemon' },
            async run(rawInput) {
                const input = PluginWebhookActionInputSchema.parse(rawInput);
                try {
                    const text = new TextDecoder('utf-8', { fatal: true })
                        .decode(decodePluginWebhookActionRawBody(input));
                    summarizeNote(JSON.parse(text));
                } catch {
                    return PluginWebhookActionResultSchema.parse({ kind: 'deadLetter', code: 'qa_note_invalid' });
                }
                return PluginWebhookActionResultSchema.parse({ kind: 'settled', disposition: 'accepted' });
            },
        },
    },
    webhooks: {
        'verified-notes': {
            title: 'QA verified notes',
            verifier: { kind: 'github_hmac_sha256_v1', routing: 'accountEndpoint' },
            handlerAction: { localId: 'receive-note' },
        },
    },
    ui: {
        views: [{ id: 'notes', title: 'QA notes', container: 'appPage',
            target: { kind: 'app' }, renderer: 'notes-renderer', instancePolicy: 'singleton' }],
        renderers: [{ id: 'notes-renderer', kind: 'reactNative', artifact: 'notes',
            requiredHostMethods: ['context', 'executeAction'] }],
    },
});
