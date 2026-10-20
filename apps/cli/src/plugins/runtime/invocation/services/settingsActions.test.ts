import { describe, expect, it, vi } from 'vitest';

import type { PluginSettingsContributionV2 } from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import { createStablePluginEventsBroker } from './events';
import {
    createStablePluginSettingsModel,
    createStablePluginSettingsOwner,
    type CanonicalPluginSettingsRecord,
    type StablePluginSettingsModel,
} from './settings';
import { createPluginSettingsActionInvoker } from './settingsActions';
import type { PluginInvocationServicesSeed } from './types';

const contribution: PluginSettingsContributionV2 = {
    id: 'preferences',
    version: 1,
    title: 'Preferences',
    target: { kind: 'plugin' },
    scope: 'daemon',
    fields: [{ id: 'endpoint', title: 'Endpoint', schema: { type: 'string', minLength: 4 } }],
    actions: [{
        id: 'discover',
        title: 'Discover endpoint',
        placement: { kind: 'afterField', fieldId: 'endpoint' },
        confirmation: {
            kind: 'required',
            title: 'Discover endpoint',
            description: 'Contact the provider and save the endpoint?',
            confirmLabel: 'Discover',
        },
        patchFieldIds: ['endpoint'],
    }],
    presentation: { sections: [], subagentSections: [] },
};

function nestedJson(depth: number): JsonValue {
    let value: JsonValue = 'leaf';
    for (let index = 0; index < depth; index += 1) {
        value = { next: value };
    }
    return value;
}

function seed(params: Readonly<{
    occurrenceId?: string;
    isOccurrenceCurrent?: () => boolean;
}> = {}): PluginInvocationServicesSeed {
    const controller = new AbortController();
    return {
        plugin: { id: 'acme.plugin', version: '1.0.0' },
        contribution: { id: 'preferences', qualifiedId: 'acme.plugin/settings/preferences' },
        occurrenceId: params.occurrenceId ?? 'occurrenceId-1',
        correlationId: 'correlation-1',
        surface: 'ui',
        signal: controller.signal,
        isOccurrenceCurrent: params.isOccurrenceCurrent ?? (() => true),
    };
}

describe('generic plugin settings actions', () => {
    it('requires a user gesture and confirmation before atomically applying the declared patch', async () => {
        let record: unknown | null = null;
        const owner = createStablePluginSettingsOwner({
            recordStore: {
                supports: () => true,
                read: async () => record,
                async update<T>(
                    _model: StablePluginSettingsModel,
                    operation: (current: unknown | null) => Readonly<{
                        record: CanonicalPluginSettingsRecord;
                        result: T;
                    }>,
                ): Promise<T> {
                    const next = operation(record);
                    record = next.record;
                    return next.result;
                },
            },
            broker: createStablePluginEventsBroker(),
        });
        const model = createStablePluginSettingsModel({ pluginId: 'acme.plugin', contribution });
        const confirm = vi.fn(async () => true);
        const execute = vi.fn(async () => ({ patch: { endpoint: 'https://discovered.example' } }));
        const invoker = createPluginSettingsActionInvoker({ owner, confirm, execute });

        await expect(invoker.invoke({
            declaration: contribution.actions![0]!,
            contributionId: contribution.id,
            model,
            seed: seed(),
            userGesture: false,
        })).rejects.toMatchObject({ code: 'plugin_settings_action_user_gesture_required' });
        expect(execute).not.toHaveBeenCalled();

        await expect(invoker.invoke({
            declaration: contribution.actions![0]!,
            contributionId: contribution.id,
            model,
            seed: seed(),
            userGesture: true,
            expectedRevision: '0',
            context: { credentialHandle: 'host-private' },
        })).resolves.toMatchObject({
            revision: '1',
            changedIds: ['endpoint'],
            values: { endpoint: 'https://discovered.example' },
        });
        expect(confirm).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({
                actionId: 'discover',
                settings: {},
            }),
            { credentialHandle: 'host-private' },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(record).toMatchObject({
            revision: 1,
            values: { endpoint: 'https://discovered.example' },
        });
    });

    it.each([
        { fieldCount: 2, fieldBytes: 40_000, accepted: true },
        { fieldCount: 9, fieldBytes: 60_000, accepted: false },
    ])('applies canonical final-record bounds to a $fieldCount-field Action patch', async ({ fieldCount, fieldBytes, accepted }) => {
        let record: unknown | null = null;
        const fieldIds = Array.from({ length: fieldCount }, (_, index) => `field${index}`);
        const patch = Object.fromEntries(fieldIds.map((id) => [id, 'x'.repeat(fieldBytes)]));
        const batchContribution: PluginSettingsContributionV2 = {
            ...contribution,
            fields: fieldIds.map((id) => ({ id, title: id, schema: { type: 'string' } })),
            actions: [{
                ...contribution.actions![0]!,
                placement: { kind: 'afterField', fieldId: fieldIds[0]! },
                patchFieldIds: fieldIds,
            }],
        };
        const owner = createStablePluginSettingsOwner({
            recordStore: {
                supports: () => true,
                read: async () => record,
                async update<T>(
                    _model: StablePluginSettingsModel,
                    operation: (current: unknown | null) => Readonly<{
                        record: CanonicalPluginSettingsRecord;
                        result: T;
                    }>,
                ): Promise<T> {
                    const next = operation(record);
                    record = next.record;
                    return next.result;
                },
            },
            broker: createStablePluginEventsBroker(),
        });
        const model = createStablePluginSettingsModel({ pluginId: 'acme.plugin', contribution: batchContribution });
        const invoker = createPluginSettingsActionInvoker({
            owner,
            confirm: async () => true,
            execute: async () => ({ patch }),
        });
        const invocation = invoker.invoke({
            declaration: batchContribution.actions![0]!,
            contributionId: batchContribution.id,
            model,
            seed: seed(),
            userGesture: true,
            expectedRevision: '0',
        });

        if (accepted) {
            await expect(invocation).resolves.toMatchObject({ revision: '1', values: patch });
            expect(record).toMatchObject({ revision: 1, values: patch });
        } else {
            await expect(invocation).rejects.toMatchObject({ code: 'plugin_settings_values_too_large' });
            expect(record).toBeNull();
        }
    });

    it('refuses a byte-small deeply nested settings-action patch at the canonical record bound', async () => {
        let record: unknown | null = null;
        const nestedContribution: PluginSettingsContributionV2 = {
            ...contribution,
            fields: [{
                id: 'nested',
                title: 'Nested configuration',
                schema: { type: 'object', additionalProperties: true },
            }],
            actions: [{
                ...contribution.actions![0]!,
                placement: { kind: 'afterField', fieldId: 'nested' },
                patchFieldIds: ['nested'],
            }],
        };
        const owner = createStablePluginSettingsOwner({
            recordStore: {
                supports: () => true,
                read: async () => record,
                async update<T>(
                    _model: StablePluginSettingsModel,
                    operation: (current: unknown | null) => Readonly<{
                        record: CanonicalPluginSettingsRecord;
                        result: T;
                    }>,
                ): Promise<T> {
                    const next = operation(record);
                    record = next.record;
                    return next.result;
                },
            },
            broker: createStablePluginEventsBroker(),
        });
        const model = createStablePluginSettingsModel({ pluginId: 'acme.plugin', contribution: nestedContribution });
        const deepPatchValue = nestedJson(128);
        const invoker = createPluginSettingsActionInvoker({
            owner,
            confirm: async () => true,
            execute: async () => ({ patch: { nested: deepPatchValue } }),
        });

        // A declared field schema may admit deep ordinary JSON, but the scoped
        // persisted-record owner rejects it with the typed bounded-record
        // result before any write, exactly like the Account scope.
        await expect(invoker.invoke({
            declaration: nestedContribution.actions![0]!,
            contributionId: nestedContribution.id,
            model,
            seed: seed(),
            userGesture: true,
            expectedRevision: '0',
        })).rejects.toMatchObject({ code: 'plugin_settings_values_too_large' });
        expect(record).toBeNull();
    });

    it('admits only one invocation for the same contribution action at a time', async () => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const owner = createStablePluginSettingsOwner({
            recordStore: {
                supports: () => true,
                read: async () => null,
                async update<T>(
                    _model: StablePluginSettingsModel,
                    operation: (current: unknown | null) => Readonly<{
                        record: CanonicalPluginSettingsRecord;
                        result: T;
                    }>,
                ): Promise<T> {
                    return operation(null).result;
                },
            },
            broker: createStablePluginEventsBroker(),
        });
        const model = createStablePluginSettingsModel({ pluginId: 'acme.plugin', contribution });
        const invoker = createPluginSettingsActionInvoker({
            owner,
            confirm: async () => true,
            execute: async () => {
                await pending;
                return { patch: { endpoint: 'https://discovered.example' } };
            },
        });
        const input = {
            declaration: contribution.actions![0]!,
            contributionId: contribution.id,
            model,
            seed: seed(),
            userGesture: true,
        } as const;
        const first = invoker.invoke(input);
        await expect(invoker.invoke(input))
            .rejects.toMatchObject({ code: 'plugin_settings_action_busy' });
        release();
        await expect(first).resolves.toMatchObject({ revision: '1' });
    });

    it('does not let a retired occurrenceId that ignores cancellation block its replacement', async () => {
        let oldCurrent = true;
        let releaseOld!: () => void;
        let enteredOld!: () => void;
        const oldPending = new Promise<void>((resolve) => { releaseOld = resolve; });
        const oldEntered = new Promise<void>((resolve) => { enteredOld = resolve; });
        const owner = createStablePluginSettingsOwner({
            recordStore: {
                supports: () => true,
                read: async () => null,
                async update<T>(
                    _model: StablePluginSettingsModel,
                    operation: (current: unknown | null) => Readonly<{
                        record: CanonicalPluginSettingsRecord;
                        result: T;
                    }>,
                ): Promise<T> {
                    return operation(null).result;
                },
            },
            broker: createStablePluginEventsBroker(),
        });
        const model = createStablePluginSettingsModel({ pluginId: 'acme.plugin', contribution });
        const invoker = createPluginSettingsActionInvoker({
            owner,
            confirm: async () => true,
            execute: async (_input, context) => {
                if (context === 'old') {
                    enteredOld();
                    await oldPending;
                }
                return { patch: { endpoint: 'https://discovered.example' } };
            },
        });
        const oldInvocation = invoker.invoke({
            declaration: contribution.actions![0]!,
            contributionId: contribution.id,
            model,
            seed: seed({ occurrenceId: 'occurrenceId-old', isOccurrenceCurrent: () => oldCurrent }),
            userGesture: true,
            context: 'old',
        });
        await oldEntered;
        oldCurrent = false;

        await expect(invoker.invoke({
            declaration: contribution.actions![0]!,
            contributionId: contribution.id,
            model,
            seed: seed({ occurrenceId: 'occurrenceId-new' }),
            userGesture: true,
            context: 'new',
        })).resolves.toMatchObject({ revision: '1' });

        releaseOld();
        await expect(oldInvocation).rejects.toMatchObject({
            code: 'plugin_settings_action_generation_retired',
        });
    });
});
