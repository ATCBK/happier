import * as React from 'react';

import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import type { WorkspaceFileEditorHeaderModel } from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileEditorHeaderModel';
import { retryMachineReachability } from '@/components/workspaces/reachability/checkoutReachability';
import { resolveFileEditorNoticeLine, type FileEditorNoticeReachability } from './fileEditorNoticeLineModel';

/** Region component for the File page's notice slot: it folds in and out with the shared disclosure motion. */
export const FileEditorNoticeLine = React.memo(function FileEditorNoticeLine(
  props: Readonly<{
    editor: WorkspaceFileEditorHeaderModel;
    editing: boolean;
    reachability: FileEditorNoticeReachability;
    agentName: string | null;
    onOpenApproval?: (() => void) | null;
  }>,
) {
  const line = resolveFileEditorNoticeLine({ ...props, onRetryReachability: retryMachineReachability });
  // The line keeps its last words while it folds away, so it never empties before it closes.
  const shownRef = React.useRef(line);
  if (line) shownRef.current = line;
  const shown = shownRef.current;
  return (
    <ExpandableItem
      expanded={line !== null}
      onExpandedChange={ignoreExpandedChange}
      header={renderNoHeader}
      showDivider={false}
    >
      {shown ? (
        <SurfaceFreshnessLine
          testID={`file-editor-notice-${shown.key}`}
          tone={shown.tone}
          glyph={shown.glyph}
          reason={shown.reason}
          emphasis={shown.emphasis}
          actions={shown.actions}
        />
      ) : null}
    </ExpandableItem>
  );
});

const ignoreExpandedChange = () => {};
const renderNoHeader = () => null;
