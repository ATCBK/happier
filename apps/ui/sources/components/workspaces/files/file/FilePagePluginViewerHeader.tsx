import * as React from 'react';
import { Platform } from 'react-native';

import { useCheckoutReachability } from '@/components/workspaces/reachability/checkoutReachability';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { t } from '@/text';
import { desktopHostKind } from '@/utils/platform/desktopHost';
import { FilePageHeader } from './FilePageHeader';
import { formatFilePageBytes } from './FilePageStates';
import { resolveFileMenuItems } from './fileMenus';
import { useWorkspaceFileShareActions } from './useWorkspaceFileShareActions';

const noop = () => {};

/**
 * The File page header while a plugin viewer owns the body (P3 §3.9, gap 18): the same header, mode-less —
 * name, breadcrumb, facts and `⋯` — with no view segment and no Find (both act on the built-in body). Edit
 * stays for text and opens the built-in editor, so nothing is lost behind a plugin viewer.
 */
export function FilePagePluginViewerHeader(
  props: Readonly<{
    scope: WorkspaceScopeBase;
    filePath: string;
    sizeBytes?: number | null;
    /** Text files: leave the viewer for the built-in editor. */
    onEdit?: () => void;
    onRevealInFilesTree?: (path: string) => void;
  }>,
) {
  const reachability = useCheckoutReachability(props.scope);
  const accountScope = useActiveServerAccountScope(
    props.scope.serverId ?? null,
  );
  const machineReachable = !reachability.unreachable;
  const unavailableReason = t('projects.checkouts.notAnswering', {
    machine: reachability.machineName,
  });
  const share = useWorkspaceFileShareActions({
    workspaceScope: props.scope,
    path: props.filePath,
    actionScope: accountScope,
    machineReachable,
    unavailableReason,
  });
  const menuActions = resolveFileMenuItems(
    {
      machineReachable,
      unavailableReason,
      hasCachedContent: false,
      platform:
        Platform.OS === 'ios' || Platform.OS === 'android'
          ? Platform.OS
          : desktopHostKind() === 'tauri'
            ? 'tauri'
            : 'web',
      revealInFiles: props.onRevealInFilesTree
        ? () => props.onRevealInFilesTree?.(props.filePath)
        : undefined,
      copyPath: share.copyPath ? () => share.copyPath?.() : undefined,
      copyLink: share.copyLink,
      download: () => share.download(),
      shareFile: share.shareFile,
      openInDefaultApp: share.openInDefaultApp,
    },
    'page',
  ).map((item) => ({
    id: item.id,
    title: item.title ?? t(item.titleKey),
    testID: `file-menu-${item.id}`,
    category: item.group,
    ...(typeof item.state === 'object'
      ? { disabled: true, subtitle: item.state.disabledReason }
      : {}),
    ...(item.id === 'download' && share.busy ? { loading: true } : {}),
    onSelect: () => item.run(),
  }));
  const fileName = props.filePath.split('/').pop() ?? props.filePath;
  return (
    <FilePageHeader
      fileName={fileName}
      filePath={props.filePath}
      onOpenFolder={props.onRevealInFilesTree}
      summaryFacts={
        typeof props.sizeBytes === 'number'
          ? [formatFilePageBytes(props.sizeBytes)]
          : null
      }
      modes={[]}
      displayMode="file"
      onDisplayMode={noop}
      find={null}
      edit={props.onEdit ? { kind: 'edit', onPress: props.onEdit } : null}
      menuActions={menuActions}
      diffMode="pending"
      onDiffMode={noop}
      hasPendingDelta={false}
      hasIncludedDelta={false}
      scmWriteEnabled={false}
      includeExcludeEnabled={false}
      virtualSelectionEnabled={false}
      isSelectedForCommit={false}
      lineSelectionEnabled={false}
      selectedLineCount={0}
      isApplyingStage={false}
      inFlightScmOperation={null}
      onStageFile={noop}
      onUnstageFile={noop}
      onApplySelectedLines={noop}
      onClearSelection={noop}
      fileEditorEnabled
    />
  );
}
