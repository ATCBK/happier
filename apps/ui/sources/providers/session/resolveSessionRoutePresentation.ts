import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import type { SessionModelRefV2 } from '@happier-dev/protocol/providers/selection/v2';
import type { SavedSecretSlotBindingsV1 } from '@happier-dev/protocol/providers/settings/v1';
import type { ProviderConnectionV1 } from '@happier-dev/protocol/providers/connections/v1';
import { ProviderContributionV1Schema } from '@happier-dev/protocol/providers/contributions';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolveSavedSecretSlotBindingIdV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { t } from '@/text';
import type { DaemonProviderModelProjectionGroupV1 } from '@happier-dev/protocol/rpc';
import { presentProviderConnectionIdentity } from '@/providers/connection/presentation';

export type RouteSelection = ProviderBoundModelRef | SessionModelRefV2 | null;
export type ProviderRouteSource = Readonly<{
    connectionId: string; providerName: string; connectionName: string;
    connectionRole: 'default' | 'named'; connectionDisplayNameMode: 'automatic' | 'custom';
    suppressedConnectedServiceIds?: readonly string[];
}> & Partial<Pick<DaemonProviderModelProjectionGroupV1, 'authorization' | 'rows'>>;
export type SessionRoute = Readonly<
    { kind: 'unknown' } |
    { kind: 'native'; sourceLabel: string; authSource: 'native' | 'connected' | 'mixed' | 'unknown'; connectedCount: number; modelId: string | null } |
    { kind: 'provider'; connectionId: string; sourceLabel: string | null; modelId: string; unavailable: boolean } |
    { kind: 'team'; teamId: string; resourceId: string; deliveryMode: 'direct' | 'brokered'; sourceLabel: string | null; modelId: string }
>;
export type SessionRoutePresentationInput = Readonly<{
    phase: 'draft' | 'running'; selection: RouteSelection;
    appliedSelection?: RouteSelection; transitionPending?: boolean;
    native: Readonly<{ label: string; authSource: 'native' | 'connected' | 'mixed' | 'unknown'; connectedCount: number }>;
    /** Runtime binding display snapshot, not a recomputed proposed connection. */
    appliedProviderSource?: ProviderRouteSource | null;
    sources?: readonly ProviderRouteSource[];
    teamSources?: readonly Readonly<{ teamId: string; resourceId: string; displayName: string }>[];
}>;

/** Discloses only credential use for the resolved route, without returning its private SavedSecret reference. */
export function projectProviderRouteSignInPurposes(input: Readonly<{
    route: SessionRoute;
    machineId: string;
    secretBindings?: SavedSecretSlotBindingsV1;
    /** Null means the source declares no runtime credential, even if a retired binding remains. */
    credentialSlotId?: string | null;
    /** Already resolved, locally materialized managed-purpose names. */
    managedSignInPurposes?: readonly string[];
}>): readonly string[] {
    if (input.route.kind !== 'provider' || !input.route.sourceLabel || !input.machineId) return [];
    if (input.managedSignInPurposes) return input.managedSignInPurposes;
    if (input.credentialSlotId === null) return [];
    return resolveSavedSecretSlotBindingIdV1(input.secretBindings, input.machineId, input.credentialSlotId ?? 'apiKey')
        ? [input.route.sourceLabel] : [];
}

/** Safe selected connection facts from the same admitted target descriptor that launch consumes. */
export function readProviderConnectionDisclosureSource(input: Readonly<{
    connection: ProviderConnectionV1;
    projection: PluginProjectionV2 | null | undefined;
    machineId: string;
    resolveServiceTitle: (service: PluginContributionIdentityV1) => string;
}>): Readonly<{ source: ProviderRouteSource; credentialSlotId: string | null; managedSignInPurposes?: readonly string[] }> {
    const connection = input.connection;
    const projected = connection.source.kind === 'contribution'
        ? input.projection?.familiesById.providers?.entriesById[connection.source.contributionKey] : null;
    const parsed = ProviderContributionV1Schema.safeParse(projected?.definition);
    const definition = parsed.success ? parsed.data : null;
    const credential = connection.source.kind === 'custom' ? connection.source.template.credential : definition?.credential;
    const source = { connectionId: connection.id,
        providerName: connection.source.kind === 'custom' ? connection.source.template.name : definition?.name ?? connection.displayName,
        connectionName: connection.displayName, connectionRole: connection.role, connectionDisplayNameMode: connection.displayNameMode };
    if (connection.deployment.kind !== 'managedLocal') return { source,
        credentialSlotId: credential?.transports.some(transport => transport.uses.includes('runtime')) ? credential.slotId : null };
    const local = !connection.gatewayPlacement || connection.gatewayPlacement.kind === 'sessionMachine'
        || connection.gatewayPlacement.machineId === input.machineId;
    const managedSignInPurposes = local ? (definition?.managedRuntime?.connectedAccounts ?? []).flatMap(declaration => {
        const target = connection.purposeBindingDefaults?.[declaration.purpose];
        if (!target) return [];
        const service = target.kind === 'account' ? target.account.service : target.service;
        return [input.resolveServiceTitle(service)];
    }) : [];
    return { source, credentialSlotId: null, managedSignInPurposes: [...new Set(managedSignInPurposes)] };
}

export function providerConnectionSourceLabel(source: Omit<ProviderRouteSource, 'connectionId'>): string {
    return presentProviderConnectionIdentity({ providerName: source.providerName, displayName: source.connectionName,
        role: source.connectionRole, displayNameMode: source.connectionDisplayNameMode }).sourceLabel;
}
/**
 * The model picker's heading for the Agent's own models: the account or pool it signs in with.
 * Null while it uses only its own sign-in (or that is unknown), where the picker keeps "Built-in".
 */
export function presentNativeRouteSourceLabel(
    native: Readonly<{ label: string; authSource: 'native' | 'connected' | 'mixed' | 'unknown' }>,
): string | null {
    return native.authSource === 'connected' || native.authSource === 'mixed' ? native.label : null;
}

function routeSourceLabel(route: SessionRoute, nativeLabel: string): string | null {
    switch (route.kind) {
        case 'unknown': return null;
        case 'native': return nativeLabel;
        case 'provider':
        case 'team': return route.sourceLabel;
    }
}

/**
 * The source a running session continues through once the next message is sent (D15): a route or
 * model picked while it runs is armed for that message, like an Agent switch. Null when nothing is
 * armed or the armed source cannot be named.
 */
export function presentArmedSessionRouteSource(
    presentation: Readonly<{ pending: SessionRoute | null }>,
    native: Readonly<{ label: string }>,
): string | null {
    return presentation.pending ? routeSourceLabel(presentation.pending, native.label) : null;
}

/**
 * The composer chip's words for a route (D6). The native case keeps the incumbent account label,
 * which follows the user's account choice as they make it. An armed change is named as what comes
 * next ("Next via …") — a choice already made, not something that needs attention. Without applied
 * evidence or an armed source there is no route to name, so it returns `null` and the caller keeps
 * its incumbent label.
 */
export function presentSessionRouteChip(
    presentation: Readonly<{ applied: SessionRoute; pending: SessionRoute | null }>,
    native: Readonly<{ label: string; authSource: 'native' | 'connected' | 'mixed' | 'unknown' }>,
): Readonly<{ label: string }> | null {
    const armed = presentArmedSessionRouteSource(presentation, native);
    if (armed) return { label: t('connectedServices.authChip.nextVia', { source: armed }) };
    const applied = presentation.applied;
    if (applied.kind === 'native' && native.authSource === 'unknown') return null;
    const source = routeSourceLabel(applied, native.label);
    if (!source) return null;
    return {
        label: applied.kind === 'native' && native.authSource === 'native'
            ? t('connectedServices.authChip.runsThroughOwnSignIn')
            : t('connectedServices.authChip.runsThrough', { source }),
    };
}

export function resolveSessionRoutePresentation(input: SessionRoutePresentationInput): Readonly<{ applied: SessionRoute; pending: SessionRoute | null }> {
    const resolve = (selection: RouteSelection, applied: boolean): SessionRoute => {
        if (selection && 'source' in selection && selection.source === 'team_resource') {
            const source = input.teamSources?.find(source => source.teamId === selection.teamId && source.resourceId === selection.resourceId);
            return { kind: 'team', teamId: selection.teamId, resourceId: selection.resourceId,
                deliveryMode: selection.deliveryMode, modelId: selection.modelId, sourceLabel: source?.displayName ?? null };
        }
        const connectionId = selection && 'source' in selection
            ? selection.source === 'account_provider_connection' ? selection.providerConnectionId : null
            : selection?.providerConnectionId ?? null;
        if (connectionId && selection) {
            const current = input.sources?.find(source => source.connectionId === connectionId);
            const source = applied && input.appliedProviderSource?.connectionId === connectionId
                ? input.appliedProviderSource : current;
            return { kind: 'provider', connectionId, sourceLabel: source ? providerConnectionSourceLabel(source) : null,
                modelId: selection.modelId, unavailable: current === undefined };
        }
        return { kind: 'native', sourceLabel: input.native.label, authSource: input.native.authSource,
            connectedCount: input.native.connectedCount, modelId: selection?.modelId ?? null };
    };
    return {
        applied: input.phase === 'draft' ? resolve(input.selection, false)
            : input.appliedSelection ? resolve(input.appliedSelection, true) : { kind: 'unknown' },
        pending: input.phase === 'running' && input.transitionPending ? resolve(input.selection, false) : null,
    };
}
