import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, PluginSettingDescriptor, PluginSettingsChange } from '@happier-dev/plugin-sdk';
import type { SettingsService, ScopedSettingsService, SettingsScopeRef } from '@happier-dev/plugin-sdk/settings';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PluginSettingsContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/settings';
import * as module from '../fixtures/qa-plugin-authoring/qa-settings-actions/src/index.js';

let plugin: PluginTestkit | undefined;
afterEach(async () => { await plugin?.dispose(); plugin = undefined; });

// The Account settings service is the host boundary. This in-memory fixture
// observes delegation and notifications; it does not simulate Account storage.
function settingsBoundary() {
    let revision = 0;
    let values: Record<string, JsonValue> = { enabled: true, style: 'concise', unrelated: 'retain' };
    const listeners = new Set<(change: PluginSettingsChange) => void>();
    const scope = { kind: 'account' } as const;
    const groups = module.manifest.contributes.settings;
    if (!groups) throw new Error('Missing QA settings declarations');
    const fields = groups.map(group => PluginSettingsContributionV2Schema.parse(group)).flatMap((group) => {
        if (group.target.kind !== 'plugin' || group.scope !== 'account') {
            throw new Error('QA settings fixture requires plugin-scoped Account settings');
        }
        const { target, scope } = group;
        return group.fields.map((field) => {
            if (field.secret !== undefined && field.secret !== false) {
                throw new Error('QA settings fixture requires non-secret fields');
            }
            if (typeof field.title !== 'string' || (field.description !== undefined && typeof field.description !== 'string')) {
                throw new Error('QA settings fixture requires static field copy');
            }
            return {
                id: field.id,
                title: field.title,
                description: field.description,
                schema: field.schema,
                default: field.default,
                target,
                scope,
            };
        });
    }) satisfies readonly PluginSettingDescriptor[];
    const service: ScopedSettingsService = {
        async snapshot() { return { scope, revision: String(revision), values: { ...values } }; },
        async get<T extends JsonValue>(id: string) {
            // The generic SDK getter delegates type selection to its caller.
            return (values[id] ?? null) as T | null;
        },
        async set(id, value, options) {
            options?.signal?.throwIfAborted();
            values = { ...values, [id]: value }; revision += 1;
            const change = { scope, revision: String(revision), changedIds: [id], values: { ...values } };
            for (const listener of listeners) listener(change);
            return { scope, revision: String(revision) };
        },
        async reset(id, options) {
            options?.signal?.throwIfAborted();
            const value = fields.find((field) => field.id === id)?.default;
            if (value === undefined) throw new Error('Setting has no default');
            return service.set(id, value, options);
        },
        describe() { return fields; },
        watch(listener) {
            listeners.add(listener);
            return { dispose() { listeners.delete(listener); } };
        },
    };
    const settings: SettingsService = {
        forScope(request: SettingsScopeRef) {
            if (request.kind !== 'account') throw new Error('QA setting requested the wrong scope');
            return service;
        },
    };
    return { settings, service };
}

describe('QA descriptor-first settings author package', () => {
    it('uses the Account owner for both settings from every declared caller surface', async () => {
        const { settings, service } = settingsBoundary();
        plugin = await createPluginTestkit({ manifest: module.manifest, module, services: { settings } });
        const changes: PluginSettingsChange[] = [];
        const subscription = service.watch((change) => { changes.push(change); });
        for (const surface of ['agent', 'cli', 'mcp', 'ui'] as const) {
            await expect(plugin.invokeAction('reminders-set', { enabled: false }, { surface })).resolves.toMatchObject({ scope: { kind: 'account' } });
            expect(await service.get('enabled')).toBe(false);
            await expect(plugin.invokeAction('summary-style-set', { style: 'detailed' }, { surface })).resolves.toMatchObject({ scope: { kind: 'account' } });
            expect(await service.get('style')).toBe('detailed');
        }
        expect(changes.map((change) => change.changedIds)).toEqual(Array.from({ length: 4 }, () => [['enabled'], ['style']]).flat());
        expect((await service.snapshot()).values).toMatchObject({ unrelated: 'retain' });
        subscription.dispose(); subscription.dispose();
        await plugin.invokeAction('reminders-set', { enabled: true });
        expect(changes).toHaveLength(8);
        expect(await service.get('enabled')).toBe(true);
    });

    it('rejects invalid and cancelled writes while retaining settings', async () => {
        const { settings, service } = settingsBoundary();
        plugin = await createPluginTestkit({ manifest: module.manifest, module, services: { settings } });
        await expect(plugin.invokeAction('reminders-set', { enabled: 'yes' })).rejects.toThrow();
        await expect(plugin.invokeAction('summary-style-set', { style: 'invented' })).rejects.toThrow();
        await expect(plugin.invokeAction('summary-style-set', { style: 'concise', unrelated: 'replace' })).rejects.toThrow();
        const controller = new AbortController(); controller.abort();
        await expect(plugin.invokeAction('reminders-set', { enabled: false }, { signal: controller.signal })).rejects.toThrow();
        expect((await service.snapshot()).values).toEqual({ enabled: true, style: 'concise', unrelated: 'retain' });
    });

    it('fails closed when the host settings boundary is unavailable', async () => {
        plugin = await createPluginTestkit({ manifest: module.manifest, module });
        await expect(plugin.invokeAction('reminders-set', { enabled: false })).rejects.toThrow();
        await expect(plugin.invokeAction('summary-style-set', { style: 'detailed' })).rejects.toThrow();
    });
});
