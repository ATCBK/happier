import * as React from 'react';
import { Platform } from 'react-native';

import { useCheckoutReachability } from '@/components/workspaces/reachability/checkoutReachability';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { t } from '@/text';
import { desktopHostKind } from '@/utils/platform/desktopHost';
import { buildFilePageMenuActions, FilePageHeader } from './FilePageHeader';
import { formatFilePageBytes } from './FilePageStates';
import { useFilePageSharing } from './useFilePageSharing';
import { useFilePageDetailsActions } from './useFilePageDetailsActions';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { getFileLanguageFromPath } from '@/utils/code/fileLanguage';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';

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
    sessionId?: string | null;
    workspaceRefId?: string | null;
    targetKind?: 'session' | 'project';
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
  const share = useFilePageSharing({
    scope: props.scope,
    filePath: props.filePath,
    accountScope,
    sessionId: props.sessionId,
    workspaceRefId: props.workspaceRefId,
    targetKind: props.targetKind,
    machineReachable,
    unavailableReason,
    sourceFacts: typeof props.sizeBytes === 'number' ? formatFilePageBytes(props.sizeBytes) : '',
  });
  const size = useSurfaceStateSize();
  const viewerKind = resolveFileViewerKind({ path: props.filePath });
  const fileDetails = useFilePageDetailsActions({ path: props.filePath,
    kind: viewerKind.kind, kindLabel: t(viewerKind.labelKey as never) as string,
    language: getFileLanguageFromPath(props.filePath), sizeBytes: props.sizeBytes });
  const menuActions = buildFilePageMenuActions(
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
      showInfo: fileDetails.showInfo,
      chooseBackground: fileDetails.chooseBackground,
      copyPath: share.copyPath ? intent => share.copyPath?.({ absolute: intent?.altKey === true }) : undefined,
      copyAbsolutePath: share.copyAbsolutePath,
      copyLink: share.copyLink,
      mentionInComposer: share.mentionInComposer,
      saveAsArtifact: share.saveAsArtifact,
      download: () => share.download(),
      shareFile: share.shareFile,
      openInDefaultApp: share.openInDefaultApp,
    },
    size === 'phone' ? 'phone' : 'page',
    { details: fileDetails, downloadBusy: share.busy },
  );
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
