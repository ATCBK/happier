import * as React from 'react';
import { View } from 'react-native';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginProjectionInstalledPackageV2 } from '@happier-dev/protocol';
import { Icon } from '@/components/ui/icons/Icon';
import { InstalledPluginBrandMark } from '@/components/plugins/shared/InstalledPluginBrandMark';
import { useServerInstalledPluginBrand } from '@/components/settings/plugins/PluginMark';
import { getPreferredLanguage } from '@/text';
import { resolvePluginContributedActionIconName } from '@/components/plugins/actions/pluginContributedActionPresentation';
import { launchPluginSurfaceAction } from '@/components/plugins/surfaces/launchPluginSurfaceAction';
import { createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import type { ManagedPrerequisiteV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

type Provisioner = MachineProvisionersListResultV1['provisioners'][number];
/**
 * A provisioner's mark at each slot it stands in (lab `l12-kit.js` / `screens-x-machines.js`): a page
 * header, a receipt's identity or a provider tile, a list row, the collection rail. No tile behind it.
 */
export const MANAGED_PROVISIONER_MARK_SIZE = {
    header: 28,
    receipt: 22,
    tile: 22,
    row: 17,
    rail: 15,
} as const;

type ProvisionerMarkProps = Readonly<{
    icon?: string;
    size: number;
    installedPackage?: PluginProjectionInstalledPackageV2 | null;
    machineId?: string;
    serverId: string;
    /** The controller's projection is still loading and the descriptor's glyph isn't known yet. */
    resolving?: boolean;
}>;

/** The provisioner's identity: its package's contributed brand mark, else the glyph its descriptor names. */
function ManagedProvisionerMark(props: ProvisionerMarkProps) {
    if (props.installedPackage?.brand?.state === 'available' && props.machineId) return <ManagedProvisionerBrandMark {...props} />;
    // Hold the mark's place blank rather than draw the generic glyph and swap it for the real one a moment later.
    if (props.resolving) return <View style={{ width: props.size, height: props.size }} />;
    return <ManagedProvisionerGlyph icon={props.icon} size={props.size} />;
}

function ManagedProvisionerBrandMark(props: ProvisionerMarkProps) {
    const brand = useServerInstalledPluginBrand(props);
    return brand?.bytes ? <InstalledPluginBrandMark brand={brand} externallyLabelled pixelSize={props.size} />
        : <ManagedProvisionerGlyph icon={props.icon} size={props.size} />;
}

function ManagedProvisionerGlyph(props: Readonly<{ icon?: string; size: number }>) {
    return <Icon name={resolvePluginContributedActionIconName(props.icon)} size={props.size} />;
}

/** Catalog declarations own display identity; the selected controller's admitted bundles own translation. */
export function useManagedProvisionerPresentation(input: Readonly<{
    serverId: string; controller?: ManagedControllerV1;
    provisioner?: MachineProvisionersListResultV1['provisioners'][number];
    provider?: Provisioner['contribution']; schemaVersion?: number;
    /** Changes when the person asks to read again: the projection is read anew. */
    refreshKey?: number;
}>) {
    const projection = useDaemonMergedProjectionInputs({ serverId: input.serverId, machineId: input.controller?.machineId, enabled: !!input.controller,
        ...(input.refreshKey === undefined ? {} : { refreshKey: input.refreshKey }) });
    const uiProjection = React.useMemo(() => normalizePluginUiProjection(projection.inputs?.pluginProjectionV2 ?? null), [projection.inputs?.pluginProjectionV2]);
    const locale = getPreferredLanguage();
    const projected = input.provider ? projection.inputs?.pluginProjectionV2?.familiesById.machineProvisioners?.entriesById[
        buildQualifiedPluginContributionKey(input.provider)] : undefined;
    const provisioner = input.provisioner ?? (projected && projected.definition.schemaVersion === input.schemaVersion
        ? { contribution: { pluginId: projected.pluginId, localId: projected.definition.id }, descriptor: projected.definition } : undefined);
    const localized = React.useMemo(() => createPluginLocalizedTextResolver({
        projection: uiProjection,
        locale,
    }), [uiProjection, locale]);
    const currentController = React.useRef(input.controller);
    currentController.current = input.controller;
    const repair = async (action: NonNullable<ManagedPrerequisiteV1['repairAction']>, binding: ServerCredentialAccountScopeBinding,
        signal?: AbortSignal) => {
        const controller = input.controller;
        if (!controller || !binding.isCurrent() || projection.phase !== 'ready') return { ok: false as const, code: 'unavailable', reason: 'controller_unavailable' };
        const result = await launchPluginSurfaceAction({ action: action.action, input: action.input,
            contributedAction: { machineId: controller.machineId, serverId: input.serverId, accountLifetime: binding },
            pluginUiProjection: uiProjection, resolveContributedAction: createPluginUiProjectedActionResolver(uiProjection.actionsById),
            ...(signal ? { signal } : {}),
            isCurrent: () => binding.isCurrent() && currentController.current?.machineId === controller.machineId
                && currentController.current?.installationId === controller.installationId,
        });
        return result.outcome;
    };
    const installedPackages = projection.inputs?.pluginProjectionV2?.installedPackagesById;
    // The brand belongs to the package, so a recipe whose definition this controller no longer projects
    // (another schema version) still carries its provider's mark.
    const markedProvisioner = provisioner ?? (input.provider ? { contribution: input.provider } : undefined);
    const projectionResolving = Boolean(input.controller) && !projection.inputs
        && (projection.phase === 'loading' || projection.phase === 'idle');
    // Each slot owner names the size it draws the mark at; the header's is the default.
    const markFor = (row?: Readonly<{ contribution: Provisioner['contribution']; descriptor?: Pick<Provisioner['descriptor'], 'icon'> }>,
        size: number = MANAGED_PROVISIONER_MARK_SIZE.header) => (
        <ManagedProvisionerMark icon={row?.descriptor?.icon} size={size} resolving={!row?.descriptor?.icon && projectionResolving}
            installedPackage={row ? installedPackages?.[row.contribution.pluginId] : null} machineId={input.controller?.machineId} serverId={input.serverId} />
    );
    return { localized, title: provisioner ? localized(provisioner.contribution.pluginId, provisioner.descriptor.title) : null,
        kindTitle: provisioner?.descriptor.kindTitle ? localized(provisioner.contribution.pluginId, provisioner.descriptor.kindTitle) : null,
        description: provisioner?.descriptor.description ? localized(provisioner.contribution.pluginId, provisioner.descriptor.description) : null,
        resourceIdPath: provisioner?.descriptor.resourceIdPath ?? null,
        mark: markFor(markedProvisioner), markAt: (size: number) => markFor(markedProvisioner, size), markFor,
        projection: uiProjection, projectionReady: projection.phase === 'ready',
        projectionFailed: projection.phase === 'error' || projection.phase === 'unsupported', repair };
}

/**
 * A preset's provider mark (the rail and the machine picker): the provisioner its recipe names, read
 * through its controller's projection like the preset page, at the size the row draws it.
 */
export function ManagedPresetMark(props: Readonly<{
    serverId: string;
    preset: Pick<ManagedMachinePresetV1, 'controller' | 'recipe'>;
    size: number;
}>) {
    const presentation = useManagedProvisionerPresentation({ serverId: props.serverId, controller: props.preset.controller,
        provider: props.preset.recipe.provider, schemaVersion: props.preset.recipe.schemaVersion });
    return presentation.markAt(props.size);
}
