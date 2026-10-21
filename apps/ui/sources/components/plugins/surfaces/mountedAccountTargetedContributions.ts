import { PluginError } from '@happier-dev/plugin-sdk';
import { resolveManifestTargetedContributions } from '@happier-dev/plugin-sdk/host/registration';
import { computePluginAccountBundledDeclarationDigestV1 } from '@happier-dev/protocol/plugins/availability';
import {
    DaemonPluginUiTargetedSurfaceMountV1Schema,
    PluginUiTargetedSurfaceMountCoreV1Schema,
    readDaemonPluginUiTargetedSurfaceMountV1,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    projectPluginUiTargetedContributionIdentityV1,
    projectPluginUiTargetedContributionsV1,
} from '@happier-dev/protocol/plugins/ui/targetedContributions';
import { selectPluginUiRendererChainMemberV1, resolvePluginUiRendererProjectionEntry } from '@happier-dev/protocol/plugins/contributions/ui';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { PluginUiAccountExecutableOrigin } from '../reactNative/executableModuleHost';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { machinePluginUiTargetedContributionsRead } from '@/sync/ops/machineContributionRegistryProjection';
import { createPluginSurfaceTargetedDeclarationSource } from './pluginSurfaceTargetedDeclarations';
import type { MountedPluginUiTargetedSurfaceMountV1 } from './mountedTargetedContributions';

/** Adapts current Account custody into the shared admitted semantic/mount owners. */
export async function readMountedAccountTargetedContributions(input: Readonly<{
    pluginId: string;
    origin: PluginUiAccountExecutableOrigin;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal: AbortSignal;
    machine?: Readonly<{ machineId: string; serverId?: string | null }>;
    isCurrent(): boolean;
}>) {
    const availability = readPluginAccountAvailability(input.accountLifetime.scope);
    const assertCurrent = () => {
        input.signal.throwIfAborted();
        const selected = availability.readCurrentAccountExecution(input.pluginId);
        if (!input.isCurrent() || !input.accountLifetime.isCurrent()
            || input.origin.serverId !== input.accountLifetime.scope.serverId
            || input.origin.accountId !== input.accountLifetime.scope.accountId
            || selected.kind !== 'available' || selected.custodyId !== input.origin.custodyId
            || !pluginSourceCustodyV1Equal(selected.sourceCustody, input.origin.sourceCustody)) {
            throw new PluginError({ code: 'plugin_action_generation_retired' });
        }
    };
    assertCurrent();
    const source = createPluginSurfaceTargetedDeclarationSource(input);
    const declarations = await source.readCurrentDeclarations();
    assertCurrent();
    const admitted = resolveManifestTargetedContributions(declarations);
    const readSourceCustody = (pluginId: string, occurrenceId: string) => declarations.find(row => (
        row.manifest.id === pluginId && row.occurrenceId === occurrenceId
    ))?.sourceCustody;
    const projectIdentity = <TIdentity extends Readonly<{ pluginId: string; occurrenceId: string }>>(identity: TIdentity) => (
        projectPluginUiTargetedContributionIdentityV1({ identity, readSourceCustody })
    );
    const readSnapshots = (pluginId: string, occurrenceId: string) => {
        const declaration = declarations.find(row => row.manifest.id === pluginId && row.occurrenceId === occurrenceId);
        if (!declaration) throw new PluginError({ code: 'plugin_targeted_contributions_unavailable' });
        return declaration.manifest.contributes.pluginContributionPoints.flatMap(point => [...point.protocols]
            .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : left.version - right.version)
            .map(protocol => {
                const snapshot = admitted.read({ targetPluginId: pluginId, pointId: point.id, protocol });
                if (!snapshot || snapshot.target.occurrenceId !== occurrenceId) {
                    throw new PluginError({ code: 'plugin_targeted_contributions_unavailable' });
                }
                return { point: { pointId: point.id, protocol: { id: protocol.id, version: protocol.version } }, snapshot };
            }));
    };
    const snapshots = readSnapshots(input.pluginId, input.origin.custodyId);
    const target = { pluginId: input.pluginId, occurrenceId: input.origin.custodyId };
    const targetedContributions = projectPluginUiTargetedContributionsV1({ target, snapshots, readSourceCustody });
    const projection = availability.readAccountUiProjection();
    const entriesById = { ...projection?.unknownEntriesById, ...projection?.reactNativeBundlesById, ...projection?.hostedWebById };
    const mounts: MountedPluginUiTargetedSurfaceMountV1[] = [];
    let machineRead: Awaited<ReturnType<typeof machinePluginUiTargetedContributionsRead>> | undefined;
    for (const { point, snapshot } of snapshots) {
        for (const contribution of snapshot.contributions) {
            for (const surface of contribution.surfaces) {
                const contributor = projectIdentity(surface.contributor);
                const selection = availability.readCurrentAccountExecution(contributor.pluginId);
                if (selection.kind !== 'available' || selection.custodyId !== contributor.occurrenceId
                    || !pluginSourceCustodyV1Equal(selection.sourceCustody, contributor.sourceCustody)) {
                    if (!input.machine) continue;
                    machineRead ??= await machinePluginUiTargetedContributionsRead(input.machine.machineId, {
                        serverId: input.machine.serverId, pluginId: input.pluginId,
                        accountLifetime: input.accountLifetime, signal: input.signal,
                    });
                    assertCurrent();
                    if (!machineRead.supported) continue;
                    const machineMount = readDaemonPluginUiTargetedSurfaceMountV1({
                        mounts: machineRead.targetedSurfaceMounts, target: machineRead.targetedContributions.target,
                        surface: { point, contributor, role: surface.role, presentation: surface.presentation },
                    });
                    if (machineMount) mounts.push(DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
                        ...machineMount, target: targetedContributions.target,
                        // The Account target owns its admitted role input; the
                        // Machine supplies only this exact contributor mount.
                        inputSchema: surface.inputSchema,
                    }));
                    continue;
                }
                const candidates = surface.rendererChain.flatMap(renderer => {
                    const entry = entriesById[`uiRenderer:${renderer.pluginId}:${renderer.definition.id}`];
                    return entry ? [{ identity: renderer.identity, entry }] : [];
                });
                const availableIds = candidates.filter(({ entry }) => {
                    const state = entry.availability;
                    return state && typeof state === 'object' && 'state' in state && state.state === 'available';
                }).map(({ identity }) => identity.localId);
                const selectedIdentity = selectPluginUiRendererChainMemberV1(surface.rendererChain.map(renderer => renderer.identity), availableIds)
                    ?? surface.rendererChain[0]?.identity;
                const selected = candidates.find(candidate => candidate.identity.pluginId === selectedIdentity?.pluginId
                    && candidate.identity.localId === selectedIdentity.localId);
                if (!selected) continue;
                const artifactProjection = selected.entry.renderer && typeof selected.entry.renderer === 'object'
                    ? resolvePluginUiRendererProjectionEntry({ pluginId: contributor.pluginId,
                        renderer: selected.entry.renderer as Readonly<Record<string, unknown>>, entriesById }) : null;
                const contributorTargetedContributions = projectPluginUiTargetedContributionsV1({
                    target: { pluginId: contributor.pluginId, occurrenceId: contributor.occurrenceId },
                    snapshots: readSnapshots(contributor.pluginId, contributor.occurrenceId), readSourceCustody,
                });
                const core = PluginUiTargetedSurfaceMountCoreV1Schema.parse({
                    kind: 'targetedSurface', target: targetedContributions.target, point, contributor,
                    role: surface.role, presentation: surface.presentation, inputSchema: surface.inputSchema,
                    rendererChain: surface.rendererChain.map(renderer => renderer.identity),
                    selectedRenderer: { identity: selected.identity, renderer: selected.entry.renderer,
                        availability: selected.entry.availability, ...(artifactProjection ? { artifactProjection } : {}) },
                    resourceCapability: { readable: false, dynamic: false }, contributorTargetedContributions,
                });
                if (selection.sourceCustody.kind !== 'account_release' && selection.sourceCustody.kind !== 'bundled_first_party') continue;
                mounts.push(Object.freeze({ ...core, accountExecutionOrigin: Object.freeze({
                    ...input.accountLifetime.scope, custodyId: selection.custodyId, sourceCustody: selection.sourceCustody,
                    ...(selection.sourceCustody.kind === 'bundled_first_party'
                        ? { declarationDigest: computePluginAccountBundledDeclarationDigestV1(selection.manifest) } : {}),
                }) }));
            }
        }
    }
    assertCurrent();
    return { supported: true as const, targetedContributions, targetedSurfaceMounts: Object.freeze(mounts) };
}
