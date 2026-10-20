import * as React from 'react';
import type { SessionExecutionTargetV1, SessionOrganizationPlacementV1 } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionOrganizationProjection } from '@/sync/domains/state/storage';
import { buildSessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { buildSessionOrganizationTagLabelById } from '@/sync/domains/session/organization/tagLabels';
import {
    buildSessionFolderWorkspaceTargets,
    selectAvailableSessionFolders,
} from '@/sync/domains/session/folders';
import {
    createSessionOrganizationTagWithLabel,
    requireSessionOrganizationMutationScope,
} from '@/sync/ops/sessionOrganization';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { HappyError } from '@/utils/errors/errors';

import {
    isNewSessionOrganizationPlacementAvailable,
    normalizeNewSessionOrganizationPlacement,
    reconcileNewSessionOrganizationPlacementForWorkspace,
    resolveNewSessionFolderWorkspace,
} from './newSessionOrganizationPlacementState';
import { createNewSessionOrganizationPlacementActionChips } from './newSessionOrganizationPlacementActionChips';

export function useNewSessionOrganizationPlacement(params: Readonly<{
    executionTarget: SessionExecutionTargetV1 | null;
    directory: string;
    /** `managed`: a no-folder draft, placed in its machine's Chats scope. */
    directoryKind?: 'path' | 'managed';
    initialPlacement?: SessionOrganizationPlacementV1 | null;
    /** A retained recipe keeps its authored placement until its target or directory is edited. */
    reconcileWorkspace?: boolean;
}>): Readonly<{
    enabled: boolean;
    valid: boolean;
    placement: SessionOrganizationPlacementV1;
    /** The folders this draft's workspace may be placed in, for a host that shows the folder as a field. */
    folderTargets: readonly Readonly<{ folderId: string; title: string; depth: number }>[];
    actionChips: readonly AgentInputExtraActionChip[];
    setFolderId: (folderId: string | null) => void;
    setTagIds: (tagIds: readonly string[]) => void;
}> {
    const { theme } = useUnistyles();
    const serverId = params.executionTarget?.serverId ?? '';
    const enabled = useFeatureEnabled('sessions.folders', serverId
        ? { scopeKind: 'spawn', serverId }
        : { scopeKind: 'main_selection' });
    const projection = useSessionOrganizationProjection(serverId);
    const viewState = React.useMemo(() => buildSessionOrganizationListViewState({ serverId, projection }), [projection, serverId]);
    const folders = viewState.sessionFoldersV1.folders;
    const availableFolders = React.useMemo(
        () => selectAvailableSessionFolders(viewState.sessionFoldersV1),
        [viewState.sessionFoldersV1],
    );
    const workspace = React.useMemo(() => resolveNewSessionFolderWorkspace({
        executionTarget: params.executionTarget,
        directory: params.directory,
        directoryKind: params.directoryKind,
    }), [params.directory, params.directoryKind, params.executionTarget]);
    const folderTargets = React.useMemo(
        () => workspace
            ? buildSessionFolderWorkspaceTargets({ folders: availableFolders, workspace })
            : [],
        [availableFolders, workspace],
    );
    const tags = React.useMemo(() => {
        const labels = buildSessionOrganizationTagLabelById(projection?.tagsById ?? {});
        return Object.entries(labels).map(([id, label]) => ({ id, label }));
    }, [projection]);
    const [placement, setPlacement] = React.useState(() => normalizeNewSessionOrganizationPlacement(params.initialPlacement));

    React.useEffect(() => {
        setPlacement((current) => {
            if (!enabled || params.reconcileWorkspace === false) return current;
            return reconcileNewSessionOrganizationPlacementForWorkspace({
                placement: current,
                executionTarget: params.executionTarget,
                directory: params.directory,
                directoryKind: params.directoryKind,
                folders: folders.map((folder) => ({ folderId: folder.id, workspace: folder.workspace })),
            });
        });
    }, [enabled, folders, params.directory, params.directoryKind, params.executionTarget, params.reconcileWorkspace]);

    const setFolderId = React.useCallback((folderId: string | null) => {
        setPlacement((current) => normalizeNewSessionOrganizationPlacement({ ...current, folderId }));
    }, []);
    const setTagIds = React.useCallback((tagIds: readonly string[]) => {
        setPlacement((current) => normalizeNewSessionOrganizationPlacement({ ...current, tagIds: [...tagIds] }));
    }, []);
    const toggleTagId = React.useCallback((tagId: string) => {
        setPlacement((current) => normalizeNewSessionOrganizationPlacement({
            ...current,
            tagIds: current.tagIds.includes(tagId)
                ? current.tagIds.filter((candidate) => candidate !== tagId)
                : [...current.tagIds, tagId],
        }));
    }, []);
    const createTag = React.useCallback((label: string) => {
        void (async () => {
            const scope = await requireSessionOrganizationMutationScope(serverId);
            const tag = await createSessionOrganizationTagWithLabel({
                credentials: scope.credentials,
                serverId: scope.serverId,
                serverUrl: scope.serverUrl,
                label,
            });
            setPlacement((current) => normalizeNewSessionOrganizationPlacement({
                ...current,
                tagIds: [...current.tagIds, tag.tagId],
            }));
        })().catch((error: unknown) => {
            Modal.alert(
                t('common.error'),
                error instanceof HappyError ? error.message : t('errors.unknownError'),
            );
        });
    }, [serverId]);
    const actionChips = React.useMemo(() => createNewSessionOrganizationPlacementActionChips({
        enabled,
        folderId: placement.folderId,
        tagIds: placement.tagIds,
        folderTargets,
        tags,
        iconColor: theme.colors.text.secondary,
        onFolderSelect: setFolderId,
        onTagToggle: toggleTagId,
        onTagCreate: createTag,
    }), [createTag, enabled, folderTargets, placement.folderId, placement.tagIds, setFolderId, tags, theme.colors.text.secondary, toggleTagId]);
    const valid = isNewSessionOrganizationPlacementAvailable({
        featureEnabled: enabled,
        placement,
    });

    return { enabled, valid, placement, folderTargets, actionChips, setFolderId, setTagIds };
}
