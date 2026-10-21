import * as React from 'react';
import { useWindowDimensions, View } from 'react-native';
import type { WorkspaceFileEditSetFile } from '@happier-dev/protocol/machines/workspaceFiles';

import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { machineLanguageIntelligencePreviewAction } from '@/sync/ops/machineLanguageIntelligence';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { FileRenameEditSet, type FileRenameEditSetRequest } from './CodeEditSetPopover';

/** `renameOnly`: the person wants the plain move; `done`: the review closed (it may have written). */
export type FileRenameReviewOutcome = 'renameOnly' | 'done';

/**
 * The move and importer edits a language server would make for this tree rename, when any file needs
 * an edit; null when nothing would follow the move or no server answers, so the plain move stays.
 */
export async function previewFileRenameEdits(params: Readonly<{
  scope: WorkspaceScopeBase;
  accountId: string | null;
  path: string;
  newPath: string;
}>): Promise<readonly WorkspaceFileEditSetFile[] | null> {
  const result = await machineLanguageIntelligencePreviewAction(
    params.scope.machineId,
    'code.file.rename.preview',
    { rootPath: params.scope.rootPath, path: params.path, newPath: params.newPath },
    { serverId: params.scope.serverId, ...(params.accountId ? { accountId: params.accountId } : {}) },
  ).catch(() => null);
  if (!result || result.status !== 'ok' || result.kind !== 'willRenameFiles') return null;
  return result.files.some((file) => file.edits.length > 0) ? result.files : null;
}

type DialogProps = CustomModalInjectedProps & Readonly<{
  request: FileRenameEditSetRequest;
  scope: WorkspaceScopeBase;
  accountId: string | null;
  filePath: string;
  onSettled: (outcome: FileRenameReviewOutcome) => void;
}>;

/** The review keeps one height while its files load and after it applies, like the replace review. */
function FileRenameReviewDialog(props: DialogProps) {
  const phone = useDeviceType() === 'phone';
  const window = useWindowDimensions();
  const height = Math.min(760, Math.round(window.height * 0.8));
  return (
    // Fills the card's body (the card keeps its size); the floor holds a card that sizes to content.
    <View style={phone ? { flex: 1 } : { flex: 1, minHeight: height }} testID="file-rename-review">
      <FileRenameEditSet
        request={props.request}
        scope={props.scope}
        accountId={props.accountId}
        filePath={props.filePath}
        onRenameOnly={() => props.onSettled('renameOnly')}
        onRequestClose={() => props.onSettled('done')}
      />
    </View>
  );
}

/** Opens the tree rename's review over the page and settles when the person leaves it. */
export function showFileRenameReview(params: Readonly<{
  scope: WorkspaceScopeBase;
  accountId: string | null;
  path: string;
  newPath: string;
  files: readonly WorkspaceFileEditSetFile[];
}>): Promise<FileRenameReviewOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let id = '';
    const settle = (outcome: FileRenameReviewOutcome, hide: boolean) => {
      if (settled) return;
      settled = true;
      if (hide && id) Modal.hide(id);
      resolve(outcome);
    };
    id = Modal.show({
      component: FileRenameReviewDialog,
      props: {
        request: { op: 'fileRename', newPath: params.newPath, files: params.files },
        scope: params.scope,
        accountId: params.accountId,
        filePath: params.path,
        onSettled: (outcome: FileRenameReviewOutcome) => settle(outcome, true),
      },
      accessibilityLabel: t('files.repositoryTree.rename.title'),
      chrome: {
        kind: 'card',
        header: 'none',
        material: 'solid',
        scrollHost: 'body',
        bodyScroll: 'none',
        dimensions: { size: 'lg' },
        phonePresentation: 'fullscreen',
        testID: 'file-rename-review-dialog',
      },
      onRequestClose: () => settle('done', false),
      onHostUnmount: () => settle('done', false),
    });
  });
}
