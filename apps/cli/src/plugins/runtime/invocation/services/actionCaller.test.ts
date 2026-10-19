import { describe, expect, it } from 'vitest';

import {
    createPluginActionCallerCurrentnessCheck,
    resolvePluginActionCaller,
    resolvePluginInvocationCallerExecutionOrigin,
} from './actionCaller';
import { resolvePluginMachineExecutionOrigin } from '@/plugins/runtime/resolvePluginMachineExecutionOrigin';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';

describe('resolvePluginActionCaller', () => {
    it('rejects a malformed SDK Automation cause without falling back to a direct starter', () => {
        expect(resolvePluginActionCaller({
            plugin: { id: 'acme.plugin' },
            contribution: { id: 'action' },
            occurrenceId: 'occurrence-1',
            sourceCustody: { kind: 'development', registeredRootId: 'root-a' },
            initiatingActionCaller: { kind: 'host' },
            startedBy: 'user',
            caller: { kind: 'automationRun', runId: 'run-1', automationId: 'automation-1',
                cause: { kind: 'manual', invokedAt: Number.NaN } },
        })).toBeNull();
    });

    it('preserves host-stamped process occurrence and durable source custody', () => {
        const materialization = createPluginActionCallerMaterializationFixture('acme.plugin');

        expect(resolvePluginActionCaller({
            plugin: { id: 'acme.plugin' },
            occurrenceId: ' ',
            sourceCustody: { kind: 'development', registeredRootId: 'root-a' },
            resolveCurrentPluginMaterializationRef:
                materialization.resolveCurrentPluginMaterializationRef,
        })).toBeNull();

        expect(resolvePluginActionCaller({
            plugin: { id: 'acme.plugin' },
            contribution: { id: 'action' },
            occurrenceId: 'occurrence-1',
            sourceCustody: { kind: 'development', registeredRootId: 'root-a' },
            resolveCurrentPluginMaterializationRef:
                materialization.resolveCurrentPluginMaterializationRef,
        })).toEqual({
            kind: 'plugin',
            pluginId: 'acme.plugin',
            contributionLocalId: 'action',
            occurrenceId: 'occurrence-1',
            sourceCustody: { kind: 'development', registeredRootId: 'root-a' },
            materialization: materialization.materialization,
        });
    });

    it('keeps an originless caller occurrence-current without inventing materialization custody', async () => {
        const revalidateMaterialization = async () => {
            throw new Error('originless caller must not acquire materialization authority');
        };
        const revalidateOccurrence = async ({ occurrenceId }: Readonly<{ occurrenceId: string }>) => (
            occurrenceId === 'occurrence-bundled'
        );
        const caller = resolvePluginActionCaller({
            plugin: { id: 'happier.inspector' },
            contribution: { id: 'self-check' },
            occurrenceId: 'occurrence-bundled',
            sourceCustody: {
                kind: 'bundled_first_party',
                packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-version-root-a' },
            },
        });

        expect(caller).toEqual({
            kind: 'plugin',
            pluginId: 'happier.inspector',
            contributionLocalId: 'self-check',
            occurrenceId: 'occurrence-bundled',
            sourceCustody: {
                kind: 'bundled_first_party',
                packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-version-root-a' },
            },
        });
        if (!caller) throw new Error('expected originless caller');
        await expect(createPluginActionCallerCurrentnessCheck({
            caller,
            revalidateMaterialization,
            revalidateOccurrence,
        })()).resolves.toEqual({ kind: 'current' });
    });

    describe('resolvePluginInvocationCallerExecutionOrigin', () => {
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'root-a' };
        const context = { serverIdentityId: 'srv_home-1', machineId: 'machine-1' };
        const materialization = createPluginActionCallerMaterializationFixture('acme.plugin').materialization;

        // A release-less plugin runs under its source custody yet still carries a
        // published materialization; the current-origin owner decides which identity
        // is exact, and the caller check must follow that decision rather than
        // re-deriving it from whichever custody facts happen to be present.
        it('accepts the current source origin of a caller that also carries a release-less materialization', async () => {
            const current = resolvePluginMachineExecutionOrigin({ pluginId: 'acme.plugin', context, sourceCustody });
            await expect(resolvePluginInvocationCallerExecutionOrigin(
                { pluginId: 'acme.plugin', sourceCustody, materialization },
                async () => current,
            )).resolves.toEqual(current);
        });

        it('accepts the current materialization origin of a caller carrying that materialization', async () => {
            const current = resolvePluginMachineExecutionOrigin({
                pluginId: 'acme.plugin', context, materializationId: materialization.materializationId,
            });
            await expect(resolvePluginInvocationCallerExecutionOrigin(
                { pluginId: 'acme.plugin', sourceCustody, materialization },
                async () => current,
            )).resolves.toEqual(current);
        });

        it('rejects a current origin that disagrees with the admitted caller custody', async () => {
            const otherSource = resolvePluginMachineExecutionOrigin({
                pluginId: 'acme.plugin', context, sourceCustody: { ...sourceCustody, registeredRootId: 'root-b' },
            });
            const otherMaterialization = resolvePluginMachineExecutionOrigin({
                pluginId: 'acme.plugin', context, materializationId: 'materialization-replaced',
            });
            await expect(resolvePluginInvocationCallerExecutionOrigin(
                { pluginId: 'acme.plugin', sourceCustody, materialization },
                async () => otherSource,
            )).resolves.toBeNull();
            await expect(resolvePluginInvocationCallerExecutionOrigin(
                { pluginId: 'acme.plugin', sourceCustody, materialization },
                async () => otherMaterialization,
            )).resolves.toBeNull();
        });
    });
});
