import { describe, expect, it, vi } from 'vitest';

import type {
    PluginActionDangerLevelV2,
    PluginActionSurfaceV2,
    PluginContributionPointV1,
    PluginTargetedContributionV1,
} from '@happier-dev/protocol';

import { createPluginContributionIdentity } from '@happier-dev/protocol';
import { PLUGIN_UI_TARGETED_CONTRIBUTIONS_MAX_V1 } from '@happier-dev/protocol/plugins/ui/targetedContributions';
import { definePlugin } from '@happier-dev/plugin-sdk';
import {
    defineContributionProtocol,
    type ContributionActionSurface,
} from '@happier-dev/plugin-sdk/contributions';
import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';

import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import {
    createPluginRuntimeOccurrenceId,
    type PluginRuntimeOccurrenceId,
} from '@/plugins/runtime/runtimeSlots';
import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginContributionRegistry } from './normalize/package';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { emailPlugin } from '../../../../../../packages/plugins/channel-email/src/plugin';
import { createAdmittedTargetedOperationExecutionHandle, createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import type {
    ResolvedActionContribution,
    ResolvedActionDefinition,
    ResolvedUiRendererV2Contribution,
} from './types';

const targetPluginId = 'examples.target';
const contributorPluginId = 'examples.contributor';
const pointId = 'providers';
const protocol = { id: 'provider', version: 1 } as const;
const targetOccurrenceId = createPluginRuntimeOccurrenceId(targetPluginId);
const contributorOccurrenceId = createPluginRuntimeOccurrenceId(contributorPluginId);

function point(): PluginContributionPointV1 {
    return {
        id: pointId,
        maxContributionsPerContributor: 1,
        protocols: [{
            ...protocol,
            operations: {
                setup: {
                    required: true,
                    input: { kind: 'contributorDefined' },
                    resultSchema: { type: 'object' },
                    action: { surfaces: ['plugin'], dangerLevel: 'safe' },
                },
            },
        }],
    };
}

function pointWith(params: Readonly<{
    maxContributionsPerContributor?: number;
    protocols?: PluginContributionPointV1['protocols'];
}> = {}): PluginContributionPointV1 {
    return {
        ...point(),
        ...(params.maxContributionsPerContributor === undefined
            ? {}
            : { maxContributionsPerContributor: params.maxContributionsPerContributor }),
        ...(params.protocols === undefined ? {} : { protocols: params.protocols }),
    };
}

function canonicalTargetPoint(params: Readonly<{
    operationRole?: string;
    required?: boolean;
    maxContributionsPerContributor?: number;
    surfaces?: readonly [ContributionActionSurface, ...ContributionActionSurface[]];
}> = {}) {
    const operationRole = params.operationRole ?? 'setup';
    const target = definePlugin({
        id: targetPluginId,
        version: '0.1.0',
        contributionPoints: {
            [pointId]: defineContributionProtocol({
                id: protocol.id,
                version: protocol.version,
                operations: {
                    [operationRole]: {
                        required: params.required ?? true,
                        input: { kind: 'contributorDefined' },
                        resultSchema: defineProtocolObject({}, { policy: 'closed' }),
                        action: { surfaces: params.surfaces ?? ['plugin'], dangerLevel: 'safe' },
                    },
                },
            }).point({
                maxContributionsPerContributor: params.maxContributionsPerContributor ?? 1,
            }),
        },
    });
    const definition = readCanonicalPluginManifest(target.manifest)
        ?.contributes?.pluginContributionPoints?.find((candidate) => candidate.id === pointId);
    if (!definition) {
        throw new Error('Expected one canonical target contribution point');
    }
    return {
        definition,
    };
}

/**
 * A canonical Protocol-emitted target point whose descriptor schema normalizes:
 * `additive-open/drop` makes the parser's output differ from the raw contributor
 * value, so admission ordering is observable from this boundary.
 */
function descriptorTargetPoint(): PluginContributionPointV1 {
    const target = definePlugin({
        id: targetPluginId,
        version: '0.1.0',
        contributionPoints: {
            [pointId]: defineContributionProtocol({
                id: protocol.id,
                version: protocol.version,
                descriptor: defineProtocolObject({
                    providerId: defineProtocolString({ minLength: 1 }),
                }, { policy: 'additive-open/drop' }),
                operations: {
                    refresh: {
                        required: false,
                        input: { kind: 'contributorDefined' },
                        resultSchema: defineProtocolObject({}, { policy: 'closed' }),
                        action: { surfaces: ['plugin'], dangerLevel: 'safe' },
                    },
                },
            }).point(),
        },
    });
    const definition = readCanonicalPluginManifest(target.manifest)
        ?.contributes.pluginContributionPoints?.find((candidate) => candidate.id === pointId);
    if (!definition) throw new Error('Expected one canonical descriptor target point');
    return definition;
}

function descriptorContribution(descriptor: PluginTargetedContributionV1['descriptor']): PluginTargetedContributionV1 {
    return {
        id: 'provider-a',
        target: { pluginId: targetPluginId, pointId },
        protocol,
        descriptor,
        operations: {},
    };
}

function contribution(params: Readonly<{
    id?: string;
    pluginId?: string;
    targetPluginId?: string;
    protocol?: PluginTargetedContributionV1['protocol'];
    operations?: Readonly<Record<string, string>>;
}> = {}): PluginTargetedContributionV1 {
    return {
        id: params.id ?? 'provider-a',
        target: {
            pluginId: params.targetPluginId ?? targetPluginId,
            pointId,
        },
        protocol: params.protocol ?? protocol,
        operations: params.operations ?? { setup: 'arbitrary-action' },
    };
}

function action(params: Readonly<{
    pluginId?: string;
    localId?: string;
    surfaces?: readonly PluginActionSurfaceV2[];
    dangerLevel?: PluginActionDangerLevelV2;
    hasUsableInputSchema?: boolean;
    hasOutputSchema?: boolean;
    inputHints?: ResolvedActionDefinition['inputHints'];
    outputSchema?: NonNullable<ResolvedActionDefinition['outputSchema']>;
}> = {}): ResolvedActionContribution {
    const contributionSurfaces = params.surfaces ?? ['plugin'];
    const dangerLevel = params.dangerLevel ?? 'safe';
    const definitionBase = {
        id: params.localId ?? 'arbitrary-action',
        title: 'Arbitrary action',
        description: null,
        kindVersion: 1 as const,
        placements: [],
        slash: null,
        bindings: null,
        examples: null,
        surfaces: {
            ui: contributionSurfaces.includes('ui'),
            voice: contributionSurfaces.includes('voice'),
            agent: contributionSurfaces.includes('agent'),
            mcp: contributionSurfaces.includes('mcp'),
            cli: contributionSurfaces.includes('cli'),
            rpc: false,
            api: false,
            plugin: contributionSurfaces.includes('plugin'),
        },
        inputHints: params.inputHints ?? null,
        inputSchema: {},
        execution: { target: 'daemon' },
        ...(params.hasOutputSchema === false
            ? {}
            : {
                // Target and contributor packages deliberately own independent
                // result declarations. This is not a whole-schema equality or
                // subtyping fixture.
                outputSchema: params.outputSchema ?? {
                    type: 'object',
                    properties: { providerConnectionKey: { type: 'string' } },
                    required: ['providerConnectionKey'],
                    additionalProperties: false,
                },
            }),
        scopes: ['global'],
        contributionSurfaces,
    };
    const definition: ResolvedActionDefinition = dangerLevel === 'safe'
        ? {
            ...definitionBase,
            safety: 'safe',
            dangerLevel: 'safe',
        }
        : {
            ...definitionBase,
            safety: 'danger',
            dangerLevel,
        };
    const resolvedDefinition = params.hasUsableInputSchema === false
        // Deliberately malformed registry-boundary fixture for the invalid-schema admission case.
        ? { ...definition, inputSchema: null } as unknown as ResolvedActionDefinition
        : definition;
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: params.pluginId ?? contributorPluginId,
        manifestPath: '/plugins/contributor/.happier-plugin/plugin.json',
        daemonEntryPath: null,
        definition: resolvedDefinition,
    } satisfies ResolvedActionContribution;
}

function renderer(params: Readonly<{
    pluginId?: string;
    localId?: string;
}> = {}): ResolvedUiRendererV2Contribution {
    const pluginId = params.pluginId ?? contributorPluginId;
    const localId = params.localId ?? 'triage-detail';
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId,
        identity: createPluginContributionIdentity({ pluginId, localId }),
        manifestPath: `/plugins/${pluginId}/.happier-plugin/plugin.json`,
        definition: {
            id: localId,
            kind: 'declarative',
            root: { kind: 'text', text: 'Provider detail' },
        },
    };
}

function registry(params: Readonly<{
    points?: readonly Readonly<{
        pluginId: string;
        definition: PluginContributionPointV1;
    }>[];
    contributions?: readonly Readonly<{ pluginId: string; definition: PluginTargetedContributionV1 }>[];
    actions?: readonly ResolvedActionContribution[];
    uiRenderersV2?: readonly ResolvedUiRendererV2Contribution[];
    occurrenceIdsByPluginId?: Readonly<Record<string, PluginRuntimeOccurrenceId>>;
}> = {}) {
    const defaultPoint = canonicalTargetPoint();
    const points = params.points ?? [{
        pluginId: targetPluginId,
        definition: defaultPoint.definition,
    }];
    const contributions = params.contributions ?? [{
        pluginId: contributorPluginId,
        definition: contribution(),
    }];
    const resolvedPoints = points.map((entry) => ({
        provenance: 'external' as const,
        source: { kind: 'path' as const },
        pluginId: entry.pluginId,
        identity: createPluginContributionIdentity({ pluginId: entry.pluginId, localId: entry.definition.id }),
        manifestPath: `/plugins/${entry.pluginId}/.happier-plugin/plugin.json`,
        definition: entry.definition,
    }));
    const resolvedContributions = contributions.map((entry) => ({
        provenance: 'external' as const,
        source: { kind: 'path' as const },
        pluginId: entry.pluginId,
        identity: createPluginContributionIdentity({ pluginId: entry.pluginId, localId: entry.definition.id }),
        manifestPath: `/plugins/${entry.pluginId}/.happier-plugin/plugin.json`,
        definition: entry.definition,
    }));
    return createResolvedContributionRegistry({
        // This fixture crosses the registry's public cold-input boundary; the
        // normalizer owns the production projection of these two families.
        pluginContributionPoints: resolvedPoints,
        targetedPluginContributions: resolvedContributions,
        actions: params.actions ?? [action()],
        uiRenderersV2: params.uiRenderersV2 ?? [],
        occurrenceIdsByPluginId: params.occurrenceIdsByPluginId ?? {
            [targetPluginId]: targetOccurrenceId,
            [contributorPluginId]: contributorOccurrenceId,
        },
    });
}

function targetedDiagnosticCodes(catalog: ReturnType<typeof registry>): readonly string[] {
    return Object.values(catalog.pluginDiagnosticsByPluginId)
        .flatMap((diagnostics) => diagnostics)
        .filter((diagnostic) => diagnostic.contribution !== undefined)
        .map((diagnostic) => diagnostic.code);
}

describe('targeted contribution cold admission', () => {
    it('runs retained Email transport Account input from the normalized declaration without UI form hints', async () => {
        const manifest = readCanonicalPluginManifest(emailPlugin.manifest);
        if (!manifest) throw new Error('Email manifest did not normalize');
        const loaded = {
            pluginId: manifest.id, pluginRootPath: '/plugins/email',
            manifestPath: '/plugins/email/plugin.json', daemonEntryPath: '/plugins/email/daemon.js',
            devDaemonEntryPath: null,
            sourceSpec: { kind: 'path', locator: '/plugins/email', trustPolicy: 'local_trusted', installPolicy: 'link' },
            manifest,
        } satisfies LoadedPlugin;
        const projected = buildPluginContributionRegistry({ loadedPlugins: [loaded] });
        const occurrenceId = createPluginRuntimeOccurrenceId(manifest.id);
        const catalog = createResolvedContributionRegistry({
            actions: projected.actions.map(entry => ({ ...entry, provenance: 'external', source: { kind: 'path' } })),
            pluginContributionPoints: projected.pluginContributionPoints.map(entry => ({ ...entry, provenance: 'external', source: { kind: 'path' }, identity: createPluginContributionIdentity({ pluginId: entry.pluginId, localId: entry.definition.id }) })),
            targetedPluginContributions: projected.targetedPluginContributions.map(entry => ({ ...entry, provenance: 'external', source: { kind: 'path' }, identity: createPluginContributionIdentity({ pluginId: entry.pluginId, localId: entry.definition.id }) })),
            occurrenceIdsByPluginId: { [manifest.id]: occurrenceId },
        });
        const snapshot = catalog.readAdmittedTargetedContributions?.({ targetPluginId: manifest.id, pointId: 'transports', protocol: { id: emailPlugin.contributionPoints.transports.protocol.id, version: 1 } });
        const operation = snapshot?.contributions[0]?.operations.find(entry => entry.role === 'connectionTest');
        const pollOperation = snapshot?.contributions[0]?.operations.find(entry => entry.role === 'listSince');
        if (!operation || !pollOperation) throw new Error('Missing admitted Email transport');
        const account = { service: { pluginId: manifest.id, localId: 'email-imap-smtp' }, accountId: 'retained-mailbox' };
        const caller = createPluginActionCallerMaterializationFixture(manifest.id);
        const sourceCustody = createManagedPluginSourceCustody('email-retained');
        let materializations = 0;
        let dispatchedAction = operation.action;
        const driver = definePlugin({ id: manifest.id, version: manifest.version, actions: {
            'fixture-dispatch': { title: 'Dispatch through the host', surfaces: ['plugin'],
                inputSchema: { type: 'object' }, resultSchema: { type: 'object' },
                run: (input, context) => context.services.actions.execute(dispatchedAction, input),
            },
        } });
        const emailActions = emailPlugin.manifest.contributes.actions;
        const driverActions = driver.manifest.contributes.actions;
        if (!emailActions || !driverActions) throw new Error('Expected Email and host-dispatch Action declarations');
        const transport = await createPluginTestkit({ manifest: { ...emailPlugin.manifest,
            contributes: { ...emailPlugin.manifest.contributes, actions: [...emailActions, ...driverActions] } },
            module: { async activate(api) { await emailPlugin.activate(api); await driver.activate(api); } },
            services: { connectedAccounts: { ...createUnavailablePluginServices().connectedAccounts, async materialize(_purpose, _request, options) {
                materializations += 1;
                expect(options?.expectedAccount).toEqual(account);
                // The credential store is the external boundary. Absence keeps
                // real Email parsing/classification active without opening TCP.
                return { kind: 'environment', env: {} };
            } } },
        });
        const actions = createPluginInvocationActionsService({
            seed: { plugin: { id: manifest.id, version: manifest.version }, contribution: { id: 'retest', qualifiedId: `${manifest.id}/actions/retest` }, occurrenceId, surface: 'plugin', sourceCustody,
                resolveCurrentPluginMaterializationRef: caller.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal, isOccurrenceCurrent: () => true },
            actionExecutor: { execute: vi.fn() },
            // Cross-host dispatch is a system boundary; declaration admission,
            // reconstruction and the actual registered Action parser stay real.
            invokeContributedAction: async request => {
                if (request.input === undefined) throw new Error('Expected a JSON Action input');
                return { status: 'executed', value: await transport.invokeAction('fixture-dispatch', request.input, { surface: 'plugin' }) };
            },
        });
        try {
            for (const selected of [operation, pollOperation]) {
                dispatchedAction = selected.action;
                const admitted = createAdmittedTargetedOperationExecutionHandle({ action: selected.action, selectedActionInput: selected.selectedActionInput,
                    targetProtocol: selected.targetProtocol, targetOccurrenceId: occurrenceId,
                    identity: { target: { pluginId: manifest.id }, point: { pointId: 'transports', protocol: { id: emailPlugin.contributionPoints.transports.protocol.id, version: 1 } },
                        contributor: { pluginId: manifest.id, contributionId: 'imap-smtp', occurrenceId, sourceCustody }, role: selected.role } });
                const fields: Record<string, Parameters<typeof actions.executeAdmittedTargetedOperation>[1]> = selected.role === 'listSince'
                    ? { config: {}, checkpoint: null, waitMs: 0, limit: 1 }
                    : { config: {} };
                // Test/poll each restore stripped input and accept a retained
                // matching reference, but cannot switch to another Account.
                for (const input of [{ credentialRef: account, ...fields }, fields]) {
                    await expect(actions.executeAdmittedTargetedOperation(admitted, input, { expectedSelectedConnectedAccountRef: account }))
                        .resolves.toEqual({ kind: 'notReady', reason: 'credentialInvalid' });
                }
                await expect(actions.executeAdmittedTargetedOperation(admitted, { credentialRef: { ...account, accountId: 'different-mailbox' }, ...fields }, { expectedSelectedConnectedAccountRef: account }))
                    .rejects.toMatchObject({ code: 'plugin_selected_action_input_invalid', actionHandlerInvocation: 'notStarted' });
            }
            expect(materializations).toBe(4);
        } finally { await transport.dispose(); }
    });
    it('retains the exact admitted Action selection shape instead of trusting a later UI carrier field path', () => {
        const selectionFor = (inputHints: ResolvedActionDefinition['inputHints'], bindingPaths: readonly string[] = []) => {
            const selected = action({ inputHints });
            const catalog = registry({ actions: [{ ...selected, definition: { ...selected.definition,
                connectedAccountPurposeBindings: bindingPaths.map((path, index) => ({ path, purpose: `purpose-${index}` })),
            } }] });
            return catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol })
                ?.contributions[0]?.operations[0]?.selectedActionInput;
        };

        expect(selectionFor(null)).toEqual({ kind: 'none' });
        expect(selectionFor(null, ['auth.account'])).toEqual({ kind: 'connectedAccount', fieldPath: 'auth.account' });
        expect(selectionFor(null, ['auth.account', 'auth.other'])).toEqual({ kind: 'unavailable' });
        expect(selectionFor({ fields: [{ path: 'account', title: 'Account', widget: 'select', connectedAccountOptions: true }] }, ['auth.account']))
            .toEqual({ kind: 'unavailable' });
        expect(selectionFor({
            fields: [{
                path: 'credentialRef',
                title: 'Credential',
                widget: 'select',
                connectedAccountOptions: true,
            }],
        })).toEqual({ kind: 'connectedAccount', fieldPath: 'credentialRef' });
        expect(selectionFor({
            fields: [
                { path: 'credentialRef', title: 'Credential', widget: 'select', connectedAccountOptions: true },
                { path: 'token', title: 'Token', widget: 'secret' },
            ],
        })).toEqual({ kind: 'unavailable' });
        expect(selectionFor({
            fields: [
                { path: 'first', title: 'First', widget: 'select', connectedAccountOptions: true },
                { path: 'second', title: 'Second', widget: 'select', connectedAccountOptions: true },
            ],
        })).toEqual({ kind: 'unavailable' });
    });

    it('uses the target-authored descriptor parser before publishing a cold admitted snapshot without activation', () => {
        const descriptor = defineProtocolObject({
            providerId: defineProtocolString({ minLength: 1 }),
        }, { policy: 'additive-open/drop' });
        const detail = defineProtocolObject({
            providerId: defineProtocolString({ minLength: 1 }),
        }, { policy: 'additive-open/drop' });
        const activate = vi.fn();
        const target = definePlugin({
            id: targetPluginId,
            version: '0.1.0',
            contributionPoints: {
                [pointId]: defineContributionProtocol({
                    id: protocol.id,
                    version: protocol.version,
                    descriptor,
                    operations: {
                        refresh: {
                            required: false,
                            input: { kind: 'contributorDefined' },
                            resultSchema: defineProtocolObject({}, { policy: 'closed' }),
                            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
                        },
                    },
                    surfaces: {
                        detail: {
                            required: true,
                            inputSchema: detail,
                            presentation: 'content',
                        },
                    },
                }).point(),
            },
            setup: activate,
        });
        const targetManifest = readCanonicalPluginManifest(target.manifest);
        const targetPoint = targetManifest?.contributes.pluginContributionPoints?.[0];
        if (!targetPoint) throw new Error('Expected target contribution point');

        const catalog = registry({
            points: [{
                pluginId: targetPluginId,
                definition: targetPoint,
            }],
            contributions: [{
                pluginId: contributorPluginId,
                definition: {
                    id: 'provider-a',
                    target: { pluginId: targetPluginId, pointId },
                    protocol,
                    descriptor: { providerId: 'github', futureDescriptorField: 'ignored' },
                    operations: {},
                    surfaces: { detail: { renderer: 'triage-detail' } },
                },
            }],
            actions: [],
            uiRenderersV2: [renderer()],
        });

        const admitted = catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol });
        expect(admitted?.contributions[0]?.descriptor).toEqual({ providerId: 'github' });
        expect(admitted?.contributions[0]?.surfaces.map((surface) => surface.role)).toEqual(['detail']);
        expect(admitted?.contributions[0]?.surfaces[0]?.targetProtocol.inputSchema.safeParse({
            providerId: 'github',
            futureSurfaceField: 'ignored',
        })).toEqual({ success: true, data: { providerId: 'github' } });
        expect(activate).not.toHaveBeenCalled();
    });

    it('admits additive descriptor fields through the target parser normalization', () => {
        const catalog = registry({
            points: [{ pluginId: targetPluginId, definition: descriptorTargetPoint() }],
            contributions: [{
                pluginId: contributorPluginId,
                definition: descriptorContribution({ providerId: 'github', futureDescriptorField: 'ignored' }),
            }],
            actions: [],
        });

        expect(catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol })
            ?.contributions[0]?.descriptor).toEqual({ providerId: 'github' });
        expect(targetedDiagnosticCodes(catalog)).toEqual([]);
    });

    it('attributes an unparsable descriptor to the target parser rather than a pre-parser schema gate', () => {
        const catalog = registry({
            points: [{ pluginId: targetPluginId, definition: descriptorTargetPoint() }],
            contributions: [{
                pluginId: contributorPluginId,
                definition: descriptorContribution({ providerId: '', futureDescriptorField: 'ignored' }),
            }],
            actions: [],
        });

        expect(catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol })?.contributions)
            .toEqual([]);
        expect(targetedDiagnosticCodes(catalog)).toEqual(['descriptor_semantic_invalid']);
    });

    it('retains a null descriptor rehydrated from the target-owned Protocol schema', () => {
        const target = definePlugin({
            id: targetPluginId,
            version: '0.1.0',
            contributionPoints: {
                [pointId]: defineContributionProtocol({
                    id: protocol.id,
                    version: protocol.version,
                    descriptor: defineProtocolLiteral(null),
                    operations: {
                        refresh: {
                            required: false,
                            input: { kind: 'contributorDefined' },
                            resultSchema: defineProtocolObject({}, { policy: 'closed' }),
                            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
                        },
                    },
                }).point(),
            },
        });
        const targetPoint = readCanonicalPluginManifest(target.manifest)
            ?.contributes.pluginContributionPoints?.[0];
        if (!targetPoint) throw new Error('Expected target contribution point');

        const catalog = registry({
            points: [{ pluginId: targetPluginId, definition: targetPoint }],
            contributions: [{
                pluginId: contributorPluginId,
                definition: {
                    id: 'provider-a',
                    target: { pluginId: targetPluginId, pointId },
                    protocol,
                    descriptor: null,
                    operations: {},
                },
            }],
            actions: [],
        });

        expect(catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol })?.contributions)
            .toEqual([expect.objectContaining({ descriptor: null })]);
        expect(targetedDiagnosticCodes(catalog)).toEqual([]);
    });

    it('rehydrates Protocol-emitted nested unknown-key semantics from the exact-generation manifest', () => {
        const descriptor = defineProtocolObject({
            drop: defineProtocolObject({
                known: defineProtocolString(),
            }, { policy: 'additive-open/drop' }),
            preserve: defineProtocolObject({
                known: defineProtocolString(),
            }, { policy: 'additive-open/preserve' }),
            typed: defineProtocolObject({
                known: defineProtocolString(),
            }, {
                policy: 'additive-open/preserve',
                additionalProperties: defineProtocolString({ minLength: 1 }),
            }),
        }, { policy: 'closed' });
        const target = definePlugin({
            id: targetPluginId,
            version: '0.1.0',
            contributionPoints: {
                [pointId]: defineContributionProtocol({
                    id: protocol.id,
                    version: protocol.version,
                    descriptor,
                    operations: {
                        refresh: {
                            required: false,
                            input: { kind: 'contributorDefined' },
                            resultSchema: defineProtocolObject({}, { policy: 'closed' }),
                            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
                        },
                    },
                }).point(),
            },
        });
        const targetManifest = readCanonicalPluginManifest(target.manifest);
        const targetPoint = targetManifest?.contributes.pluginContributionPoints?.[0];
        if (!targetPoint) throw new Error('Expected serialized target contribution point');

        const catalog = registry({
            points: [{
                pluginId: targetPluginId,
                definition: targetPoint,
            }],
            contributions: [{
                pluginId: contributorPluginId,
                definition: {
                    id: 'provider-a',
                    target: { pluginId: targetPluginId, pointId },
                    protocol,
                    descriptor: {
                        drop: { known: 'drop', future: 'discarded' },
                        preserve: { known: 'preserve', future: 'retained' },
                        typed: { known: 'typed', future: 'also-retained' },
                    },
                    operations: {},
                },
            }],
            actions: [],
        });

        expect(catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol })?.contributions)
            .toEqual([expect.objectContaining({
                descriptor: {
                    drop: { known: 'drop' },
                    preserve: { known: 'preserve', future: 'retained' },
                    typed: { known: 'typed', future: 'also-retained' },
                },
            })]);
        expect(targetedDiagnosticCodes(catalog)).toEqual([]);
    });

    it('rejects a contribution that omits the descriptor a target protocol declares', () => {
        // A declared descriptor schema is a required contribution field, not an
        // optional one that is merely validated when present. Admitting the
        // omission handed the target an entry with no descriptor at all.
        const descriptor = defineProtocolObject({
            providerId: defineProtocolString({ minLength: 1 }),
        }, { policy: 'additive-open/drop' });
        const target = definePlugin({
            id: targetPluginId,
            version: '0.1.0',
            contributionPoints: {
                [pointId]: defineContributionProtocol({
                    id: protocol.id,
                    version: protocol.version,
                    descriptor,
                    operations: {
                        refresh: {
                            required: false,
                            input: { kind: 'contributorDefined' },
                            resultSchema: defineProtocolObject({}, { policy: 'closed' }),
                            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
                        },
                    },
                }).point(),
            },
        });
        const targetPoint = readCanonicalPluginManifest(target.manifest)
            ?.contributes.pluginContributionPoints?.[0];
        if (!targetPoint) throw new Error('Expected target contribution point');
        const points = [{
            pluginId: targetPluginId,
            definition: targetPoint,
        }] as const;
        const withoutDescriptor = registry({
            points,
            contributions: [{
                pluginId: contributorPluginId,
                definition: {
                    id: 'provider-a',
                    target: { pluginId: targetPluginId, pointId },
                    protocol,
                    operations: {},
                },
            }],
            actions: [],
        });
        const withDescriptor = registry({
            points,
            contributions: [{
                pluginId: contributorPluginId,
                definition: {
                    id: 'provider-a',
                    target: { pluginId: targetPluginId, pointId },
                    protocol,
                    descriptor: { providerId: 'github' },
                    operations: {},
                },
            }],
            actions: [],
        });

        expect(targetedDiagnosticCodes(withoutDescriptor)).toEqual(['descriptor_missing']);
        expect(withoutDescriptor.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol }))
            .toEqual(expect.objectContaining({ contributions: [] }));
        expect(targetedDiagnosticCodes(withDescriptor)).toEqual([]);
        expect(withDescriptor.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol })
            ?.contributions[0]?.descriptor).toEqual({ providerId: 'github' });
    });

    it('rejects descriptor semantics from an external JSON target before structural schema preparation', () => {
        const descriptorProtocol: PluginContributionPointV1['protocols'][number] = {
            ...protocol,
            descriptor: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
                additionalProperties: false,
            },
            operations: point().protocols[0]!.operations,
        };
        const firstContributorPluginId = 'examples.contributor.first';
        const secondContributorPluginId = 'examples.contributor.second';
        const catalog = registry({
            points: [{
                pluginId: targetPluginId,
                definition: pointWith({ protocols: [descriptorProtocol] }),
            }],
            contributions: [{
                pluginId: firstContributorPluginId,
                definition: {
                    ...contribution(),
                    descriptor: { name: 'First provider' },
                },
            }, {
                pluginId: secondContributorPluginId,
                definition: {
                    ...contribution(),
                    descriptor: { name: 'Second provider' },
                },
            }],
            actions: [
                action({ pluginId: firstContributorPluginId }),
                action({ pluginId: secondContributorPluginId }),
            ],
            occurrenceIdsByPluginId: {
                [targetPluginId]: targetOccurrenceId,
                [firstContributorPluginId]: createPluginRuntimeOccurrenceId(firstContributorPluginId),
                [secondContributorPluginId]: createPluginRuntimeOccurrenceId(secondContributorPluginId),
            },
        });

        expect(catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol })?.contributions)
            .toEqual([]);
        expect(targetedDiagnosticCodes(catalog)).toEqual([
            'target_semantics_unavailable',
            'target_semantics_unavailable',
        ]);
    });

    it('fans out one contributor-owned semantic diagnostic per rejected contribution', () => {
        const descriptorProtocol: PluginContributionPointV1['protocols'][number] = {
            ...protocol,
            descriptor: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
                additionalProperties: false,
            },
            operations: point().protocols[0]!.operations,
        };
        const firstContributorPluginId = 'examples.contributor.first';
        const secondContributorPluginId = 'examples.contributor.second';
        const catalog = registry({
            points: [{ pluginId: targetPluginId, definition: pointWith({ protocols: [descriptorProtocol] }) }],
            contributions: [{
                pluginId: firstContributorPluginId,
                definition: { ...contribution({ id: 'provider-first' }), descriptor: { name: 'First provider' } },
            }, {
                pluginId: secondContributorPluginId,
                definition: { ...contribution({ id: 'provider-second' }), descriptor: { name: 'Second provider' } },
            }],
            actions: [
                action({ pluginId: firstContributorPluginId }),
                action({ pluginId: secondContributorPluginId }),
            ],
            occurrenceIdsByPluginId: {
                [targetPluginId]: targetOccurrenceId,
                [firstContributorPluginId]: createPluginRuntimeOccurrenceId(firstContributorPluginId),
                [secondContributorPluginId]: createPluginRuntimeOccurrenceId(secondContributorPluginId),
            },
        });

        expect(catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol })?.contributions)
            .toEqual([]);
        expect(catalog.pluginDiagnosticsByPluginId[targetPluginId]).toBeUndefined();
        expect(catalog.pluginDiagnosticsByPluginId[firstContributorPluginId])
            .toEqual([expect.objectContaining({ code: 'target_semantics_unavailable' })]);
        expect(catalog.pluginDiagnosticsByPluginId[secondContributorPluginId])
            .toEqual([expect.objectContaining({ code: 'target_semantics_unavailable' })]);
    });

    it('rejects surface semantics from an external JSON target before structural schema preparation', () => {
        const detailProtocol: PluginContributionPointV1['protocols'][number] = {
            ...protocol,
            operations: point().protocols[0]!.operations,
            surfaces: {
                detail: {
                    required: true,
                    inputSchema: {
                        type: 'object',
                        properties: { reviewId: { type: 'string' } },
                        required: ['reviewId'],
                        additionalProperties: false,
                    },
                    presentation: 'content',
                },
            },
        };
        const catalog = registry({
            points: [{
                pluginId: targetPluginId,
                definition: pointWith({
                    maxContributionsPerContributor: 2,
                    protocols: [detailProtocol],
                }),
            }],
            contributions: [{
                pluginId: contributorPluginId,
                definition: {
                    ...contribution({ id: 'provider-one' }),
                    surfaces: { detail: { renderer: 'triage-detail' } },
                },
            }, {
                pluginId: contributorPluginId,
                definition: {
                    ...contribution({ id: 'provider-two' }),
                    surfaces: { detail: { renderer: 'triage-detail' } },
                },
            }],
            uiRenderersV2: [renderer()],
        });

        expect(catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol })?.contributions)
            .toEqual([]);
        expect(targetedDiagnosticCodes(catalog)).toEqual([
            'target_semantics_unavailable',
            'target_semantics_unavailable',
        ]);
    });

    it('rejects missing unknown role references before omitting valid unknown roles from target authority', () => {
        const missingUnknownOperation = registry({
            contributions: [{
                pluginId: contributorPluginId,
                definition: contribution({ operations: {
                    setup: 'arbitrary-action',
                    futureRole: 'future-action-not-installed',
                } }),
            }],
        });
        const missingUnknownSurface = registry({
            contributions: [{
                pluginId: contributorPluginId,
                definition: {
                    ...contribution(),
                    surfaces: {
                        futureDetail: { renderer: 'future-renderer-not-installed' },
                    },
                },
            }],
        });

        expect(missingUnknownOperation.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol }))
            .toEqual(expect.objectContaining({ contributions: [] }));
        expect(targetedDiagnosticCodes(missingUnknownOperation)).toEqual(['action_not_found']);
        expect(missingUnknownSurface.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol }))
            .toEqual(expect.objectContaining({ contributions: [] }));
        expect(targetedDiagnosticCodes(missingUnknownSurface)).toEqual(['renderer_not_found']);
    });

    it('does not treat structural descriptor and surface validation as target semantic authority', () => {
        const detailProtocol: PluginContributionPointV1['protocols'][number] = {
            ...protocol,
            descriptor: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
                additionalProperties: false,
            },
            operations: point().protocols[0]!.operations,
            surfaces: {
                detail: {
                    required: true,
                    inputSchema: { type: 'object' },
                    presentation: 'content' as const,
                },
            },
        };
        const catalog = registry({
            points: [{
                pluginId: targetPluginId,
                definition: pointWith({ protocols: [detailProtocol] }),
            }],
            contributions: [{
                pluginId: contributorPluginId,
                definition: {
                    ...contribution(),
                    descriptor: { name: 'Acme Provider' },
                    surfaces: {
                        detail: {
                            renderer: 'triage-detail',
                        },
                        futureDetail: {
                            // An additive future optional role belongs to a
                            // newer contributor contract. The older target
                            // verifies its same-contributor renderer chain,
                            // then omits it from target authority.
                            renderer: 'triage-detail',
                        },
                    },
                },
            }],
            uiRenderersV2: [renderer()],
        });

        expect(catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol })?.contributions)
            .toEqual([]);
        expect(targetedDiagnosticCodes(catalog)).toEqual(['target_semantics_unavailable']);
    });

    it('does not publish external target surfaces across reads without exact semantic refs', () => {
        const detailProtocol: PluginContributionPointV1['protocols'][number] = {
            ...protocol,
            operations: point().protocols[0]!.operations,
            surfaces: {
                detail: {
                    required: true,
                    inputSchema: {
                        type: 'object',
                        properties: { reviewId: { type: 'string' } },
                        required: ['reviewId'],
                        additionalProperties: false,
                    },
                    presentation: 'content',
                },
            },
        };
        const catalog = registry({
            points: [{
                pluginId: targetPluginId,
                definition: pointWith({ protocols: [detailProtocol] }),
            }],
            contributions: [{
                pluginId: contributorPluginId,
                definition: {
                    ...contribution(),
                    surfaces: { detail: { renderer: 'triage-detail' } },
                },
            }],
            uiRenderersV2: [renderer()],
        });

        const first = catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol });
        const second = catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol });
        expect(first?.contributions).toEqual([]);
        expect(second?.contributions).toEqual([]);
        expect(targetedDiagnosticCodes(catalog)).toEqual(['target_semantics_unavailable']);
    });

    it('fails closed before compiling external target surface semantics', () => {
        const invalidSurfaceProtocol: PluginContributionPointV1['protocols'][number] = {
            ...protocol,
            operations: point().protocols[0]!.operations,
            surfaces: {
                detail: {
                    required: true,
                    inputSchema: { anyOf: [] },
                    presentation: 'content',
                },
            },
        };
        const catalog = registry({
            points: [{
                pluginId: targetPluginId,
                definition: pointWith({ protocols: [invalidSurfaceProtocol] }),
            }],
            contributions: [{
                pluginId: contributorPluginId,
                definition: {
                    ...contribution(),
                    surfaces: { detail: { renderer: 'triage-detail' } },
                },
            }],
            uiRenderersV2: [renderer()],
        });

        expect(catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol })?.contributions)
            .toEqual([]);
        expect(targetedDiagnosticCodes(catalog)).toEqual(['target_semantics_unavailable']);
    });

    it('fails closed for every contributor shape when an external target declares semantics', () => {
        const detailProtocol: PluginContributionPointV1['protocols'][number] = {
            ...protocol,
            descriptor: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
                additionalProperties: false,
            },
            operations: point().protocols[0]!.operations,
            surfaces: {
                detail: {
                    required: true,
                    inputSchema: { type: 'object' },
                    presentation: 'fill' as const,
                },
            },
        };
        const pointWithDetail = [{
            pluginId: targetPluginId,
            definition: pointWith({ protocols: [detailProtocol] }),
        }] as const;
        const invalidDescriptor = registry({
            points: pointWithDetail,
            contributions: [{
                pluginId: contributorPluginId,
                definition: { ...contribution(), descriptor: { name: 42 }, surfaces: { detail: { renderer: 'triage-detail' } } },
            }],
            uiRenderersV2: [renderer()],
        });
        const missingRequiredSurface = registry({
            points: pointWithDetail,
            contributions: [{
                pluginId: contributorPluginId,
                definition: { ...contribution(), descriptor: { name: 'Acme Provider' } },
            }],
            uiRenderersV2: [renderer()],
        });
        const missingRenderer = registry({
            points: pointWithDetail,
            contributions: [{
                pluginId: contributorPluginId,
                definition: {
                    ...contribution(),
                    descriptor: { name: 'Acme Provider' },
                    surfaces: { detail: { renderer: 'missing-renderer' } },
                },
            }],
        });

        expect(targetedDiagnosticCodes(invalidDescriptor))
            .toEqual(['target_semantics_unavailable']);
        expect(targetedDiagnosticCodes(missingRequiredSurface))
            .toEqual(['target_semantics_unavailable']);
        expect(targetedDiagnosticCodes(missingRenderer))
            .toEqual(['target_semantics_unavailable']);
    });

    it('admits an arbitrary same-contributor Action from cold normalized declarations without exposing unknown roles', () => {
        const catalog = registry({
            contributions: [{
                pluginId: contributorPluginId,
                definition: contribution({ operations: {
                    setup: 'arbitrary-action',
                    futureRole: 'arbitrary-action',
                } }),
            }],
        });
        if (!catalog.readAdmittedTargetedContributions) {
            throw new Error('targeted_contribution_admission_reader_missing');
        }
        const admitted = catalog.readAdmittedTargetedContributions({ targetPluginId, pointId, protocol });

        expect(admitted).toMatchObject({
            target: {
                pluginId: targetPluginId,
                pointId,
                occurrenceId: targetOccurrenceId,
            },
            contributions: [{
                contributor: {
                    pluginId: contributorPluginId,
                    contributionId: 'provider-a',
                    occurrenceId: contributorOccurrenceId,
                },
                protocol,
                operations: [{
                    role: 'setup',
                    action: { pluginId: contributorPluginId, localId: 'arbitrary-action' },
                    contributor: {
                        pluginId: contributorPluginId,
                        contributionId: 'provider-a',
                        occurrenceId: contributorOccurrenceId,
                    },
                    selectedActionInput: { kind: 'none' },
                    targetProtocol: expect.objectContaining({ role: 'setup' }),
                }],
                surfaces: [],
            }],
        });
    });

    it('requires every bound Action to declare a result schema without comparing independently packaged schemas', () => {
        const independentlyDeclaredResult = registry({
            actions: [action({
                outputSchema: {
                    type: 'object',
                    properties: { providerConnectionKey: { type: 'string' } },
                    required: ['providerConnectionKey'],
                    additionalProperties: false,
                },
            })],
        });
        const missingResultSchema = registry({
            actions: [action({ hasOutputSchema: false })],
        });

        expect(independentlyDeclaredResult.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol }))
            .toEqual(expect.objectContaining({
                contributions: [expect.objectContaining({
                    operations: [expect.objectContaining({
                        role: 'setup',
                        action: { pluginId: contributorPluginId, localId: 'arbitrary-action' },
                    })],
                })],
            }));
        expect(targetedDiagnosticCodes(independentlyDeclaredResult)).toEqual([]);
        expect(missingResultSchema.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol }))
            .toEqual(expect.objectContaining({ contributions: [] }));
        expect(targetedDiagnosticCodes(missingResultSchema))
            .toEqual(['action_schema_invalid']);
    });

    it('admits a lower-camel operation role through the target and contributor lookup maps', () => {
        const role = 'connectionTest';
        const canonical = canonicalTargetPoint({ operationRole: role });
        const catalog = registry({
            points: [{
                pluginId: targetPluginId,
                definition: canonical.definition,
            }],
            contributions: [{
                pluginId: contributorPluginId,
                definition: contribution({ operations: { [role]: 'arbitrary-action' } }),
            }],
        });

        expect(catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol }))
            .toEqual(expect.objectContaining({
                contributions: [expect.objectContaining({
                    operations: [expect.objectContaining({ role })],
                })],
            }));
    });

    it('retains an identity-only contribution when every optional operation is unknown to the target point', () => {
        const canonical = canonicalTargetPoint({ required: false });
        const catalog = registry({
            points: [{
                pluginId: targetPluginId,
                definition: canonical.definition,
            }],
            contributions: [{
                pluginId: contributorPluginId,
                // The target does not know this additive role. It still
                // references a valid same-contributor Action, then remains
                // absent from the older target's authority.
                definition: contribution({ operations: { futureRole: 'arbitrary-action' } }),
            }],
        });
        if (!catalog.readAdmittedTargetedContributions) {
            throw new Error('targeted_contribution_admission_reader_missing');
        }

        expect(catalog.readAdmittedTargetedContributions({ targetPluginId, pointId, protocol }))
            .toEqual(expect.objectContaining({
                contributions: [{
                    contributor: {
                        pluginId: contributorPluginId,
                        contributionId: 'provider-a',
                        occurrenceId: contributorOccurrenceId,
                    },
                    protocol,
                    operations: [],
                    surfaces: [],
                }],
            }));
        expect(targetedDiagnosticCodes(catalog)).toEqual([]);
    });

    it('keeps a current target with an absent point dormant with one bounded diagnostic', () => {
        const admitted = registry({ points: [] });

        if (!admitted.readAdmittedTargetedContributions) {
            throw new Error('targeted_contribution_admission_reader_missing');
        }
        expect(admitted.readAdmittedTargetedContributions({ targetPluginId, pointId, protocol })).toBeNull();
        expect(admitted.pluginDiagnosticsByPluginId[contributorPluginId]).toEqual([{
            code: 'point_absent',
            message: 'Targeted contribution admission rejected (point_absent).',
            stage: 'normalization',
            contribution: {
                pluginId: contributorPluginId,
                localId: 'provider-a',
            },
            details: {
                target: { pluginId: targetPluginId, pointId },
                contributor: { pluginId: contributorPluginId, contributionId: 'provider-a' },
                protocol,
                reason: 'point_absent',
            },
        }]);
        expect('targetedContributionDiagnostics' in admitted).toBe(false);
    });

    it('does not return a same-id point snapshot through a different protocol handle', () => {
        const catalog = registry();
        if (!catalog.readAdmittedTargetedContributions) {
            throw new Error('targeted_contribution_admission_reader_missing');
        }

        expect(catalog.readAdmittedTargetedContributions({
            targetPluginId,
            pointId,
            protocol: { id: 'other-protocol', version: 1 },
        })).toBeNull();
    });

    it('distinguishes a retired declared target from a never-declared target', () => {
        const retired = registry({
            occurrenceIdsByPluginId: {
                [contributorPluginId]: contributorOccurrenceId,
            },
        });
        const absentTargetPluginId = 'examples.absent-target';
        const absent = registry({
            contributions: [{
                pluginId: contributorPluginId,
                definition: contribution({ targetPluginId: absentTargetPluginId }),
            }],
        });

        expect(targetedDiagnosticCodes(retired)).toEqual(['target_retired']);
        expect(targetedDiagnosticCodes(absent)).toEqual(['target_absent']);
    });

    it('keeps contributor-retired, protocol, required-role, and Action contract failures out of the cold snapshot', () => {
        const cases = [
            {
                name: 'retired contributor',
                input: {
                    occurrenceIdsByPluginId: { [targetPluginId]: targetOccurrenceId },
                },
                code: 'contributor_retired',
            },
            {
                name: 'unsupported protocol',
                input: {
                    contributions: [{
                        pluginId: contributorPluginId,
                        definition: contribution({ protocol: { id: 'other', version: 1 } }),
                    }],
                },
                code: 'protocol_unsupported',
            },
            {
                name: 'missing required role',
                input: {
                    contributions: [{
                        pluginId: contributorPluginId,
                        definition: contribution({ operations: {} }),
                    }],
                },
                code: 'required_operation_missing',
            },
            {
                name: 'unknown Action',
                input: { actions: [] },
                code: 'action_not_found',
            },
            {
                name: 'Action without a usable schema',
                input: { actions: [action({ hasUsableInputSchema: false })] },
                code: 'action_schema_invalid',
            },
            {
                name: 'Action surface mismatch',
                input: { actions: [action({ surfaces: ['ui'] })] },
                code: 'action_surface_mismatch',
            },
            {
                name: 'Action danger mismatch',
                input: { actions: [action({ dangerLevel: 'writesLocal' })] },
                code: 'action_danger_level_mismatch',
            },
        ] as const;

        for (const testCase of cases) {
            const catalog = registry(testCase.input);
            expect(catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol }), testCase.name)
                .toEqual(expect.objectContaining({ contributions: [] }));
            expect(targetedDiagnosticCodes(catalog), testCase.name)
                .toEqual([testCase.code]);
        }
    });

    it('requires every target-owned operation surface before admitting the contributor Action', () => {
        const dualSurfacePoint = canonicalTargetPoint({ surfaces: ['plugin', 'ui'] }).definition;
        const catalog = (surfaces: readonly PluginActionSurfaceV2[]) => registry({
            points: [{ pluginId: targetPluginId, definition: dualSurfacePoint }],
            actions: [action({ surfaces })],
        });
        const read = (surfaces: readonly PluginActionSurfaceV2[]) => catalog(surfaces)
            .readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol });

        expect(read(['plugin'])).toEqual(expect.objectContaining({ contributions: [] }));
        expect(read(['ui'])).toEqual(expect.objectContaining({ contributions: [] }));
        const combined = catalog(['plugin', 'ui']);
        expect(targetedDiagnosticCodes(combined)).toEqual([]);
        expect(combined.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol })
            ?.contributions).toHaveLength(1);
    });

    it('rejects duplicate contribution identities and all contributions beyond one contributor-point limit', () => {
        const duplicate = registry({
            contributions: [
                { pluginId: contributorPluginId, definition: contribution({ id: 'same' }) },
                { pluginId: contributorPluginId, definition: contribution({ id: 'same' }) },
            ],
        });
        const overLimit = registry({
            contributions: [
                { pluginId: contributorPluginId, definition: contribution({ id: 'one' }) },
                { pluginId: contributorPluginId, definition: contribution({ id: 'two' }) },
            ],
        });

        expect(duplicate.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol })).toEqual({
            target: {
                pluginId: targetPluginId,
                pointId,
                occurrenceId: targetOccurrenceId,
            },
            contributions: [],
        });
        expect(targetedDiagnosticCodes(duplicate))
            .toEqual(['contribution_identity_conflict', 'contribution_identity_conflict']);
        expect(overLimit.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol })?.contributions)
            .toEqual([]);
        expect(targetedDiagnosticCodes(overLimit))
            .toEqual(['contributor_contribution_limit_exceeded', 'contributor_contribution_limit_exceeded']);
    });

    it('bounds one point snapshot at the Protocol projected-entry ceiling with one deterministic diagnostic per excess candidate', () => {
        const canonical = canonicalTargetPoint({ maxContributionsPerContributor: 2 });
        const contributions = Array.from({ length: PLUGIN_UI_TARGETED_CONTRIBUTIONS_MAX_V1 + 1 }, (_, index) => ({
            pluginId: `examples.contributor-${index}`,
            definition: contribution({ id: `provider-${String(index).padStart(3, '0')}` }),
        }));
        const occurrenceIdsByPluginId = Object.fromEntries([
            [targetPluginId, targetOccurrenceId],
            ...contributions.map((entry) => [
                entry.pluginId,
                createPluginRuntimeOccurrenceId(entry.pluginId),
            ] as const),
        ]);
        const catalog = registry({
            points: [{
                pluginId: targetPluginId,
                definition: canonical.definition,
            }],
            contributions,
            actions: contributions.map((entry) => action({ pluginId: entry.pluginId })),
            occurrenceIdsByPluginId,
        });

        expect(catalog.readAdmittedTargetedContributions?.({ targetPluginId, pointId, protocol })?.contributions)
            .toHaveLength(PLUGIN_UI_TARGETED_CONTRIBUTIONS_MAX_V1);
        expect(targetedDiagnosticCodes(catalog)).toEqual(['snapshot_limit_exceeded']);
    });
});
