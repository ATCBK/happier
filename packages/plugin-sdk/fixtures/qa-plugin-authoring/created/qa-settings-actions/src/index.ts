import { definePlugin, defineUiSurfaceDefinition } from '@happier-dev/plugin-sdk';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

const enabledInput = defineProtocolObject({ enabled: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]) }, { policy: 'closed' });
const styleInput = defineProtocolObject({ style: defineProtocolUnion([defineProtocolLiteral('concise'), defineProtocolLiteral('detailed')]) }, { policy: 'closed' });
const mutationResult = defineProtocolObject({
    scope: defineProtocolObject({ kind: defineProtocolLiteral('account') }, { policy: 'closed' }),
    revision: defineProtocolString(),
}, { policy: 'closed' });

export const { manifest, activate } = definePlugin({
    id: 'qa.settings-actions', version: '0.1.0', displayName: 'QA settings actions',
    description: 'QA-only Account preferences with one Action for each user-changeable setting.',
    entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },
    settings: { preferences: {
        title: 'Review preferences', target: { kind: 'plugin' }, scope: 'account',
        fields: [
            { id: 'enabled', title: 'Review reminders', description: 'Receive a reminder when a review is ready.', schema: { type: 'boolean' }, default: true },
            { id: 'style', title: 'Summary detail', description: 'Choose how much detail review summaries include.', schema: { type: 'string', enum: ['concise', 'detailed'] }, default: 'concise' },
        ],
    } },
    actions: {
        'reminders-set': {
            title: 'Set review reminders', execution: { target: 'daemon' }, scopes: ['global'],
            surfaces: ['agent', 'cli', 'mcp', 'ui'], dangerLevel: 'safe',
            inputSchema: enabledInput, resultSchema: mutationResult,
            async run(input, context) {
                context.signal?.throwIfAborted();
                return mutationResult.parse(await context.services.settings.forScope({ kind: 'account' }).set('enabled', input.enabled, { signal: context.signal }));
            },
        },
        'summary-style-set': {
            title: 'Set summary detail', execution: { target: 'daemon' }, scopes: ['global'],
            surfaces: ['agent', 'cli', 'mcp', 'ui'], dangerLevel: 'safe',
            inputSchema: styleInput, resultSchema: mutationResult,
            async run(input, context) {
                context.signal?.throwIfAborted();
                return mutationResult.parse(await context.services.settings.forScope({ kind: 'account' }).set('style', input.style, { signal: context.signal }));
            },
        },
    },
    ui: {
        settingsGroups: [{ id: 'review', title: 'Review preferences' }],
        surfaces: [defineUiSurfaceDefinition({
            id: 'review-preferences-page', placement: 'settingsPage',
            group: { kind: 'plugin', localId: 'review' }, title: 'QA review preferences',
            renderer: { kind: 'declarative', root: {
                kind: 'group', title: 'Review preferences',
                description: 'Choose when to hear about reviews and how their summaries read.',
                children: [
                    { kind: 'field', label: 'Review reminders', control: { kind: 'toggle', settingId: 'enabled' } },
                    { kind: 'field', label: 'Summary detail', control: { kind: 'select', settingId: 'style', options: [
                        { value: 'concise', label: 'Concise' }, { value: 'detailed', label: 'Detailed' },
                    ] } },
                ],
            } },
        })],
    },
});
