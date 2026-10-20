import * as React from 'react';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';
import type { ProjectAccountOrganizationV1, ProjectAccountRowKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readRegisteredStorageState, subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';

export type ProjectAccountRowsStatus = 'idle' | 'loading' | 'ready' | 'error' | 'locked' | 'refused';
export type ProjectOrganizationRow = Readonly<{
    key: Extract<ProjectAccountRowKeyV1, { kind: 'project-organization' }>;
    revision: number;
    value: ProjectAccountOrganizationV1;
}>;
export type ProjectAccountRowsSnapshot = Readonly<{
    scope: ServerAccountScope;
    status: ProjectAccountRowsStatus;
    coverage: 'unknown' | 'partial' | 'complete';
    workspaceRefs: readonly WorkspaceRefV1[];
    relationships: readonly WorkspaceSyncRelationshipV1[];
    organizations: readonly ProjectOrganizationRow[];
    revisionsByPhysicalKey: Readonly<Record<string, number>>;
}>;

export function readCurrentProjectAccountRows(state: Readonly<{
    projectAccountRows: ProjectAccountRowsSnapshot | null; profileScope?: ServerAccountScope | null;
}>): ProjectAccountRowsSnapshot | null {
    if ('profileScope' in state && !areServerAccountScopesEqual(state.profileScope, state.projectAccountRows?.scope)) return null;
    return state.projectAccountRows;
}

const subscribe = (listener: () => void) => subscribeRegisteredStorageState(listener) ?? (() => {});
const read = () => {
    const state = readRegisteredStorageState();
    return state ? readCurrentProjectAccountRows(state) : null;
};
/** Opened row projection through the registered sync owner's captured Account/Home. */
export function useProjectAccountRows() {
    return React.useSyncExternalStore(subscribe, read, read);
}

const doNotSubscribe = () => () => {};
const readUnavailableWorkspaceRefs = () => undefined;
/** The complete opened checkout census, shared by subscriptions and pure projections. */
export function readProjectAccountWorkspaceRefs(state: Parameters<typeof readCurrentProjectAccountRows>[0]): readonly WorkspaceRefV1[] | undefined {
    const rows = readCurrentProjectAccountRows(state);
    return rows?.status === 'ready' && rows.coverage === 'complete' ? rows.workspaceRefs : undefined;
}
const readWorkspaceRefs = () => {
    const state = readRegisteredStorageState();
    return state ? readProjectAccountWorkspaceRefs(state) : undefined;
};

/** Demand only the opened checkout facts; unrelated Project records retain the selected identity. */
export function useProjectAccountWorkspaceRefs(enabled: boolean): readonly WorkspaceRefV1[] | undefined {
    const snapshot = enabled ? readWorkspaceRefs : readUnavailableWorkspaceRefs;
    return React.useSyncExternalStore(enabled ? subscribe : doNotSubscribe, snapshot, snapshot);
}
