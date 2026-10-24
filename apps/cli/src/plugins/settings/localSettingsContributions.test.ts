import { describe, expect, it } from 'vitest';

import type { PluginSettingsContributionV2 } from '@happier-dev/protocol';
import type { ResolvedSettingsContribution } from '@/plugins/projection/registry/types';

import { admitLocalSettingsDeclarations, resolveLocalSettingsDeclarations } from './localSettingsContributions';

function settingsContribution(
    id: string,
    scope: PluginSettingsContributionV2['scope'],
    fieldSchema: PluginSettingsContributionV2['fields'][number]['schema'],
): ResolvedSettingsContribution {
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: 'acme.settings',
        definition: {
            id,
            version: 1,
            title: id,
            target: { kind: 'plugin' },
            scope,
            fields: [{ id: 'shared', title: 'Shared', schema: fieldSchema }],
            presentation: { sections: [], subagentSections: [] },
        },
    };
}

describe('local settings contribution admission', () => {
    it('validates explicit nonsecret defaults just like omitted secret declarations', () => {
        const input = settingsContribution('invalid-default', 'daemon', { type: 'boolean' });
        expect(() => resolveLocalSettingsDeclarations({ settings: [{ ...input, definition: {
            ...input.definition, fields: [{ id: 'shared', title: 'Shared', schema: { type: 'boolean' }, secret: false, default: 'true' }],
        } }] })).toThrowError(expect.objectContaining({ code: 'PLUGIN_SETTINGS_DEFAULT_INVALID', fieldId: 'shared' }));
    });

    it('isolates a conflicting group atomically without hiding another scope or plugin', () => {
        const first = settingsContribution('first', 'daemon', { type: 'string' });
        const conflicting = settingsContribution('conflicting', 'daemon', { type: 'boolean' });
        const otherScope = settingsContribution('account', 'account', { type: 'boolean' });
        const otherPlugin = { ...conflicting, pluginId: 'acme.other' };
        const admitted = admitLocalSettingsDeclarations({ settings: [first, conflicting, otherScope, otherPlugin] });
        expect(admitted.declarations.map(row => `${row.pluginId}/${row.definition.id}`))
            .toEqual(['acme.settings/first', 'acme.settings/account', 'acme.other/conflicting']);
        expect(admitted.errors).toEqual([expect.objectContaining({ code: 'PLUGIN_SETTINGS_FIELD_ID_CONFLICT',
            pluginId: 'acme.settings', contributionId: 'conflicting', fieldId: 'shared' })]);
    });

    it('propagates unexpected host faults rather than treating them as malformed author declarations', () => {
        const fault = new Error('host-fault-sentinel');
        const input = { pluginId: 'acme.settings', get definition(): never { throw fault; } };
        expect(() => admitLocalSettingsDeclarations({ settings: [input] })).toThrow(fault);
    });
    it('consumes already-admitted account and daemon settings with the same nonsecret local id', () => {
        expect(resolveLocalSettingsDeclarations({
            settings: [
                settingsContribution('account-preferences', 'account', { type: 'string' }),
                settingsContribution('daemon-preferences', 'daemon', { type: 'object', additionalProperties: true }),
            ],
        }).map((declaration) => ({
            id: declaration.definition.id,
            scope: declaration.definition.scope,
            fieldId: declaration.definition.fields[0]?.id,
        }))).toEqual([
            { id: 'account-preferences', scope: 'account', fieldId: 'shared' },
            { id: 'daemon-preferences', scope: 'daemon', fieldId: 'shared' },
        ]);
    });
});
