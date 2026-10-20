import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { refreshAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';
import { getAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';
import { storage } from '@/sync/domains/state/storage';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import {
    projectVoiceConfiguredAgentTarget,
    VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE,
    type VoiceConfiguredAgentSelection,
    type ResolvedVoiceConfiguredAgentTarget,
} from './projectVoiceConfiguredAgentTarget';

export { VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE } from './projectVoiceConfiguredAgentTarget';
export type { VoiceConfiguredAgentSelection, ResolvedVoiceConfiguredAgentTarget } from './projectVoiceConfiguredAgentTarget';

/**
 * The ONE resolver that turns the user's configured Voice Agent selection into
 * the exact backend target the spawn and start corridors execute.
 *
 * A selection carrying exact facts (target key and/or qualified identity) is
 * resolved against the current Agent catalog — the machine's projection for
 * external Agents, the local catalog for bundled ones. A selection the current
 * catalog cannot honor fails closed: spawning or starting a different Agent
 * than the one the user picked is a silent correctness bug, not a fallback.
 * Selections written before exact target facts existed keep the legacy raw-id
 * behavior so every persisted bundled profile continues to work.
 */
export async function resolveVoiceConfiguredAgentTarget(params: Readonly<{
    machineId: string | null | undefined;
    selection: VoiceConfiguredAgentSelection;
    accountScope?: ServerAccountScope | null;
    signal?: AbortSignal;
}>): Promise<ResolvedVoiceConfiguredAgentTarget> {
    const agentId = normalizeNonEmptyString(params.selection.agentId);
    const targetKeySelection = normalizeNonEmptyString(params.selection.agentTargetKey);
    const identitySelection = params.selection.agentIdentity ?? null;
    const unavailable = (): ResolvedVoiceConfiguredAgentTarget => ({
        ok: false,
        errorCode: VOICE_AGENT_SELECTION_UNAVAILABLE_ERROR_CODE,
        agentId: agentId ?? '',
        agentTargetKey: targetKeySelection,
    });
    const state = storage.getState();
    const scope = params.accountScope === undefined ? state.settingsScope : params.accountScope;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (params.accountScope !== undefined && (!scope || !lifetime
        || !areAccountSettingsScopesEqual(scope, lifetime.scope))) return unavailable();
    const backendEnabledByTargetKey = state.settings?.backendEnabledByTargetKey ?? null;
    const knownTarget = projectVoiceConfiguredAgentTarget({
        selection: params.selection, entries: null, backendEnabledByTargetKey,
    });
    if (knownTarget) return knownTarget;

    if (!scope || !lifetime || !areAccountSettingsScopesEqual(scope, lifetime.scope)) return unavailable();
    const snapshot = getAcpCatalogSnapshot(scope);
    if (snapshot?.catalog.status !== 'ready' || snapshot.stale) await refreshAcpCatalog(scope);
    if (!lifetime.isCurrent()) return unavailable();
    const externalIdentitySelection = identitySelection;
    const projectionInputs = externalIdentitySelection
        ? await loadDaemonMergedProjectionInputs({
            machineId: normalizeNonEmptyString(params.machineId),
            serverId: scope.serverId,
            signal: params.signal,
        })
        : null;
    const catalog = getAcpCatalogSnapshot(scope)?.catalog;
    if (!lifetime.isCurrent() || catalog?.status !== 'ready') return unavailable();
    const entries = getResolvedBackendCatalogEntries({
        enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey }),
        acpCatalogSnapshot: catalog,
        backendEnabledByTargetKey,
        mergedProviderProjectionById: projectionInputs?.mergedProviderProjectionById ?? null,
        mergedBackendProjectionById: projectionInputs?.mergedBackendProjectionById ?? null,
        discoveredBackendIds: projectionInputs?.discoveredBackendIds ?? undefined,
    });

    return projectVoiceConfiguredAgentTarget({
        selection: params.selection,
        entries,
        backendEnabledByTargetKey,
        mergedProviderProjectionById: projectionInputs?.mergedProviderProjectionById,
    })!;
}
