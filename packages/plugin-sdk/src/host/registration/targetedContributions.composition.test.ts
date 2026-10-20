import { describe, expect, it } from 'vitest';

import { definePlugin } from '../../definePlugin.js';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { AccountReleasePluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { defineContributionProtocol } from '../../targetedContributionAuthoring.js';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString } from '../../protocol/protocolFacade.js';
import {
    createManifestTargetedContributionsService,
    mergeTargetedContributionManifestDeclarations,
    requireAdmittedTargetedOperationExecutionBinding,
    validateTargetedOperationInput,
    validateTargetedOperationResult,
    type TargetedContributionManifestDeclaration,
} from './index.js';

const inputSchema = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
const resultSchema = defineProtocolObject({ accepted: defineProtocolLiteral(true) }, { policy: 'closed' });
const protocol = defineContributionProtocol({
    id: 'external-account-source',
    version: 1,
    operations: {
        inspect: {
            required: true,
            input: { kind: 'protocolDefined', schema: inputSchema },
            resultSchema,
            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
        },
    },
});
const target = definePlugin({
    id: 'external.account-target',
    version: '1.0.0',
    contributionPoints: { sources: protocol.point() },
});
const source = definePlugin({
    id: 'external.account-source',
    version: '1.0.0',
    actions: {
        inspect: {
            title: 'Inspect',
            surfaces: ['plugin'],
            dangerLevel: 'safe',
            execution: { target: 'account', account: { artifactId: 'portable-source', exportName: 'activateAccount' } },
            inputSchema,
            resultSchema,
            run: async () => ({ accepted: true as const }),
        },
    },
    contributesTo: {
        'external.account-target': {
            sources: {
                'personal-source': protocol.contribute({ operations: { inspect: protocol.operations.inspect.bind('inspect') } }),
            },
        },
    },
});

function rows() {
    return [target, source].map((plugin) => {
        const parsed = ingestPluginManifestV2(plugin.manifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        return {
            manifest: parsed.manifest,
            occurrenceId: `${parsed.manifest.id}:occurrence`,
            sourceCustody: AccountReleasePluginSourceCustodyV1Schema.parse({
                kind: 'account_release',
                pluginId: parsed.manifest.id,
                version: parsed.manifest.version,
                archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            }),
        };
    });
}

async function admittedOperation() {
    const declarations = rows();
    const controller = new AbortController();
    const service = createManifestTargetedContributionsService({
        readCurrentDeclarations: () => declarations,
        subscribeToCatalogChanges: () => () => {},
    }).bind({ pluginId: target.manifest.id, signal: controller.signal, isCurrent: () => true });
    const observation = service.observeForSelf(target.contributionPoints.sources, { onInvalidated() {} });
    try {
        const snapshot = await observation.readCurrent();
        const contribution = snapshot.contributions[0];
        if (!contribution) throw new Error('Expected separately authored source to be admitted');
        return { declarations, operation: contribution.operations.inspect };
    } finally {
        observation.dispose();
    }
}

describe('portable targeted contribution admission', () => {
    it('uses exact Machine source identity only for bound Machine roles, ignoring unrelated Actions', () => {
        const declarations = rows();
        const accountSource = declarations[1]!;
        const machineOnly: TargetedContributionManifestDeclaration = {
            ...accountSource,
            sourceCustody: { ...accountSource.sourceCustody, pluginId: 'external.machine-source' },
            manifest: { ...accountSource.manifest, id: 'external.machine-source', contributes: {
                ...accountSource.manifest.contributes,
                actions: [
                    { ...accountSource.manifest.contributes.actions[0]!, execution: { target: 'daemon' } },
                    { ...accountSource.manifest.contributes.actions[0]!, id: 'unrelated-settings' },
                ],
            } },
        };
        const actualMachine = { ...machineOnly, occurrenceId: 'actual-machine-occurrence' };
        const merged = mergeTargetedContributionManifestDeclarations({
            targetPluginId: target.manifest.id,
            accountDeclarations: [...declarations, machineOnly], machineDeclarations: [actualMachine, { ...declarations[0]!, occurrenceId: 'machine-target' }],
        });
        expect(merged.find((row) => row.manifest.id === target.manifest.id)).toBe(declarations[0]);
        expect(merged.find((row) => row.manifest.id === machineOnly.manifest.id)?.occurrenceId).toBe('actual-machine-occurrence');
        expect(merged.find((row) => row.manifest.id === source.manifest.id)?.occurrenceId).toBe(accountSource.occurrenceId);
        expect(mergeTargetedContributionManifestDeclarations({ targetPluginId: target.manifest.id,
            accountDeclarations: [...declarations, machineOnly], machineDeclarations: [],
        }).find((row) => row.manifest.id === machineOnly.manifest.id)).toBe(machineOnly);
        expect(mergeTargetedContributionManifestDeclarations({ targetPluginId: target.manifest.id,
            accountDeclarations: declarations, machineDeclarations: [actualMachine],
        }).find((row) => row.manifest.id === machineOnly.manifest.id)).toBe(actualMachine);
    });

    it('does not hide personal sources when one plugin binds roles from incompatible placements', () => {
        const declarations = rows();
        const accountSource = declarations[1]!;
        const mixed: TargetedContributionManifestDeclaration = {
            ...accountSource,
            sourceCustody: { ...accountSource.sourceCustody, pluginId: 'external.mixed-source' },
            manifest: { ...accountSource.manifest, id: 'external.mixed-source', contributes: {
                ...accountSource.manifest.contributes,
                actions: [...accountSource.manifest.contributes.actions,
                    { ...accountSource.manifest.contributes.actions[0]!, id: 'machine-inspect', execution: { target: 'daemon' } }],
                targetedPluginContributions: [...accountSource.manifest.contributes.targetedPluginContributions,
                    { ...accountSource.manifest.contributes.targetedPluginContributions[0]!, id: 'machine-source', operations: { inspect: 'machine-inspect' } }],
            } },
        };
        const merged = mergeTargetedContributionManifestDeclarations({ targetPluginId: target.manifest.id,
            accountDeclarations: [...declarations, mixed], machineDeclarations: [{ ...mixed, occurrenceId: 'machine-mixed' }],
        });
        expect(merged.find((row) => row.manifest.id === source.manifest.id)).toBe(accountSource);
        expect(merged.find((row) => row.manifest.id === mixed.manifest.id)?.manifest.contributes.targetedPluginContributions).toEqual([]);
    });

    it('preserves an Account source release when a different release is also installed on the Machine', async () => {
        const declarations = rows();
        const machineSource = { ...declarations[1]!,
            manifest: { ...declarations[1]!.manifest, version: '2.0.0' },
            occurrenceId: 'different-machine-release', sourceCustody: {
            ...declarations[1]!.sourceCustody, version: '2.0.0', archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
        } };
        const merged = mergeTargetedContributionManifestDeclarations({
            targetPluginId: target.manifest.id, accountDeclarations: declarations, machineDeclarations: [machineSource],
        });
        const service = createManifestTargetedContributionsService({
            readCurrentDeclarations: () => merged, subscribeToCatalogChanges: () => () => {},
        }).bind({ pluginId: target.manifest.id, signal: new AbortController().signal, isCurrent: () => true });
        const observation = service.observeForSelf(target.contributionPoints.sources, { onInvalidated() {} });
        try {
            const snapshot = await observation.readCurrent();
            const operation = snapshot.contributions[0]!.operations.inspect;
            expect(operation.identity.contributor.occurrenceId).toBe(declarations[1]!.occurrenceId);
            expect(operation.identity.contributor.sourceCustody).toEqual(declarations[1]!.sourceCustody);
        } finally { observation.dispose(); }
    });

    it('rejects an original handle after its source release has changed without an occurrence change', async () => {
        const { declarations, operation } = await admittedOperation();
        const changed = declarations.map((row) => row.manifest.id === source.manifest.id
            ? { ...row, sourceCustody: { ...row.sourceCustody, archiveDigestSha256: `sha256:${'b'.repeat(64)}` } }
            : row);

        expect(() => requireAdmittedTargetedOperationExecutionBinding(operation, {
            plugin: { id: target.manifest.id },
            occurrenceId: declarations[0]!.occurrenceId,
        }, changed)).toThrowError(expect.objectContaining({ code: 'plugin_action_generation_retired' }));
    });

    it('rejects an original handle after its role is no longer declared', async () => {
        const { declarations, operation } = await admittedOperation();
        const changed = declarations.map((row) => row.manifest.id === source.manifest.id
            ? { ...row, manifest: { ...row.manifest, contributes: { ...row.manifest.contributes, targetedPluginContributions: [] } } }
            : row);

        expect(() => requireAdmittedTargetedOperationExecutionBinding(operation, {
            plugin: { id: target.manifest.id },
            occurrenceId: declarations[0]!.occurrenceId,
        }, changed)).toThrowError(expect.objectContaining({ code: 'plugin_admitted_targeted_operation_handle_invalid' }));
    });

    it('keeps the original handle and target-owned parser pair for a current separately authored source', async () => {
        const { declarations, operation } = await admittedOperation();
        const seed = { plugin: { id: target.manifest.id }, occurrenceId: declarations[0]!.occurrenceId };
        const binding = requireAdmittedTargetedOperationExecutionBinding(operation, seed, declarations);

        expect(binding.action).toEqual({ pluginId: source.manifest.id, localId: 'inspect' });
        expect(validateTargetedOperationInput(binding.targetProtocol, { id: 'task-a' })).toEqual({ ok: true, value: { id: 'task-a' } });
        expect(validateTargetedOperationInput(binding.targetProtocol, { id: 'task-a', credential: 'extra' })).toMatchObject({
            ok: false,
            result: { errorCode: 'plugin_targeted_operation_input_invalid', actionHandlerInvocation: 'notStarted' },
        });
        expect(validateTargetedOperationResult(binding.targetProtocol, { accepted: true })).toEqual({ ok: true, value: { accepted: true } });
        expect(validateTargetedOperationResult(binding.targetProtocol, { accepted: false })).toEqual({
            ok: false,
            result: { ok: false, errorCode: 'plugin_targeted_operation_result_invalid', error: expect.any(String) },
        });
        expect(() => requireAdmittedTargetedOperationExecutionBinding({ ...operation }, seed, declarations)).toThrowError(
            expect.objectContaining({ code: 'plugin_admitted_targeted_operation_handle_invalid' }),
        );
    });

    it('retires a handle when the target release or contributor occurrence has changed', async () => {
        const { declarations, operation } = await admittedOperation();
        const seed = { plugin: { id: target.manifest.id }, occurrenceId: declarations[0]!.occurrenceId };
        for (const changed of [
            declarations.map((row) => row.manifest.id === target.manifest.id
                ? { ...row, sourceCustody: { ...row.sourceCustody, archiveDigestSha256: `sha256:${'c'.repeat(64)}` } }
                : row),
            declarations.map((row) => row.manifest.id === source.manifest.id ? { ...row, occurrenceId: 'replacement-source-occurrence' } : row),
            declarations.filter((row) => row.manifest.id !== source.manifest.id),
        ]) {
            expect(() => requireAdmittedTargetedOperationExecutionBinding(operation, seed, changed)).toThrowError(
                expect.objectContaining({ code: 'plugin_action_generation_retired' }),
            );
        }
    });
});
