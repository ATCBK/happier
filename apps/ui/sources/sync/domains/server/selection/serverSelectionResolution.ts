import { readUsableHomeServerIds } from '@/sync/domains/scope/usableHomeServerIds';

import { getEffectiveServerSelection, resolveActiveServerSelection } from './serverSelectionResolver';
import { toServerSelectionSettings } from './serverSelectionSettingsAdapter';
import type { EffectiveServerSelection, ResolvedActiveServerSelection } from './serverSelectionTypes';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { loadEffectiveHomeViewState } from './homeViewSelectionState';
import { listServerProfileScopeIds, normalizeServerSelectionSettingsForProfileScopeIds } from './serverSelectionProfileScopeIds';
import { normalizeServerSelectionGroupsForSettings } from './serverSelectionSettingsAdapter';

export type RawServerSelectionSettings = Readonly<{
    serverSelectionGroups: unknown;
    serverSelectionActiveTargetKind: unknown;
    serverSelectionActiveTargetId: unknown;
}>;

/** The answering client reads the same device/tab Home selection as mounted collection controllers. */
export function readResolvedActiveServerSelection(settings: RawServerSelectionSettings): ResolvedActiveServerSelection {
    const profiles = listServerProfiles();
    const view = loadEffectiveHomeViewState();
    const effective = view ? {
        serverSelectionGroups: normalizeServerSelectionGroupsForSettings(view.groups),
        serverSelectionActiveTargetKind: view.activeTargetKind,
        serverSelectionActiveTargetId: view.activeTargetId,
    } : settings;
    let activeServerId = '';
    try { activeServerId = getActiveServerSnapshot().serverId; } catch { /* Same empty bootstrap as the mounted selector. */ }
    return resolveActiveServerSelectionFromRawSettings({ activeServerId, availableServerIds: listServerProfileScopeIds(profiles),
        settings: normalizeServerSelectionSettingsForProfileScopeIds(effective, profiles) });
}

export function resolveActiveServerSelectionFromRawSettings(params: Readonly<{
    activeServerId: string;
    availableServerIds: ReadonlyArray<string>;
    settings: RawServerSelectionSettings;
    /** Homes this device can use; defaults to the credential-backed projection. */
    usableServerIds?: ReadonlyArray<string> | null;
}>): ResolvedActiveServerSelection {
    return resolveActiveServerSelection({
        activeServerId: params.activeServerId,
        availableServerIds: params.availableServerIds,
        settings: toServerSelectionSettings(params.settings),
        // Every reader (the session list's concurrent cache, the Home pickers) resolves the same
        // default from the same credential-backed projection.
        usableServerIds: params.usableServerIds !== undefined ? params.usableServerIds : readUsableHomeServerIds(),
    });
}

export function getEffectiveServerSelectionFromRawSettings(params: Readonly<{
    activeServerId: string;
    availableServerIds: ReadonlyArray<string>;
    settings: RawServerSelectionSettings;
    /** Homes this device can use; defaults to the credential-backed projection. */
    usableServerIds?: ReadonlyArray<string> | null;
}>): EffectiveServerSelection {
    return getEffectiveServerSelection({
        activeServerId: params.activeServerId,
        availableServerIds: params.availableServerIds,
        settings: toServerSelectionSettings(params.settings),
        // Every reader (the session list's concurrent cache, the Home pickers) resolves the same
        // default from the same credential-backed projection.
        usableServerIds: params.usableServerIds !== undefined ? params.usableServerIds : readUsableHomeServerIds(),
    });
}
