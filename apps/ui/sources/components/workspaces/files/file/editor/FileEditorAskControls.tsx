import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { usePaneMainColumn } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import type { TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { AskSelectionControls } from '@/components/ui/code/selection/AskSelectionControls';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

const NO_SUBSCRIPTION = () => () => {};

/** Ask about the editor's selection on the File page (lab AS1 A1); the editor handle supplies the selection. */
export function FileEditorAskControls(
  props: Readonly<{
    handle: TextEditorHandle | null;
    scopeId: string;
    scope: WorkspaceScopeBase;
    filePath: string;
    /** The saved bytes; a dirty editor anchors to them (RU-3). */
    savedText: string | undefined;
    sessionId: string | null;
    active: boolean;
  }>,
): React.ReactElement | null {
  const pane = useAppPaneScope(props.scopeId);
  const mainColumn = usePaneMainColumn();
  const handle = props.handle;
  const getSelection = React.useCallback(
    () => handle?.getSelection?.() ?? null,
    [handle],
  );
  const subscribeSelection = React.useMemo(
    () =>
      handle?.subscribeSelection
        ? (listener: () => void) => handle.subscribeSelection!(listener)
        : NO_SUBSCRIPTION,
    [handle],
  );
  const getLinesText = React.useCallback(
    () => handle?.getValue() ?? props.savedText ?? '',
    [handle, props.savedText],
  );
  const revealSessionColumn = React.useCallback(() => {
    if (mainColumn?.hidden) mainColumn.setHidden(false);
  }, [mainColumn]);
  const sessionTarget = React.useMemo(
    () =>
      props.sessionId
        ? { sessionId: props.sessionId, revealSessionColumn }
        : null,
    [props.sessionId, revealSessionColumn],
  );
  if (!handle?.getSelection) return null;
  return (
    <AskSelectionControls
      scopeId={props.scopeId}
      workspaceScope={props.scope}
      filePath={props.filePath}
      source="file"
      getSelection={getSelection}
      subscribeSelection={subscribeSelection}
      getLinesText={getLinesText}
      savedText={props.savedText}
      sessionTarget={sessionTarget}
      openDetailsTab={pane.openDetailsTab}
      active={props.active}
      testID="file-editor-selection-toolbar"
    />
  );
}
