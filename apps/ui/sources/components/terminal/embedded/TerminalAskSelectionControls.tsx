import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { usePaneMainColumn } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import type { XtermTerminalHandle } from '@/components/terminal/xterm/XtermTerminalView.web';
import { AskSelectionControls } from '@/components/ui/code/selection/AskSelectionControls';
import type { AskSelection } from '@/components/ui/code/selection/useAskSelection';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type TerminalAskSelectionTarget = Readonly<{
  scopeId: string;
  workspaceScope: WorkspaceScopeBase;
  /** The Session whose composer receives the quote; null asks outside a Session (side run or new session). */
  sessionId: string | null;
}>;

/**
 * Ask about a terminal selection (web): the same controls as the editor's, fed by xterm's selection.
 * The quote is unanchored (fenced text), so it lands in the composer through the canonical append.
 */
export function TerminalAskSelectionControls(
  props: Readonly<{
    target: TerminalAskSelectionTarget;
    terminalRef: React.MutableRefObject<XtermTerminalHandle | null>;
    subscribeSelection: (listener: () => void) => () => void;
    active: boolean;
  }>,
): React.ReactElement | null {
  const pane = useAppPaneScope(props.target.scopeId);
  const mainColumn = usePaneMainColumn();
  const { terminalRef } = props;
  const getSelection = React.useCallback((): AskSelection | null => {
    const handle = terminalRef.current;
    const text = handle?.hasSelection() ? handle.getSelectionText() : '';
    const range = text.trim().length > 0 ? handle?.getSelectionRange?.() : null;
    if (!range) return null;
    return {
      startLine: range.startRow,
      endLine: range.endRow,
      text,
      rect: range.rect,
    };
  }, [terminalRef]);
  const revealSessionColumn = React.useCallback(() => {
    if (mainColumn?.hidden) mainColumn.setHidden(false);
  }, [mainColumn]);
  const sessionTarget = React.useMemo(
    () =>
      props.target.sessionId
        ? { sessionId: props.target.sessionId, revealSessionColumn }
        : null,
    [props.target.sessionId, revealSessionColumn],
  );
  return (
    <AskSelectionControls
      scopeId={props.target.scopeId}
      workspaceScope={props.target.workspaceScope}
      source="terminal"
      getSelection={getSelection}
      subscribeSelection={props.subscribeSelection}
      sessionTarget={sessionTarget}
      openDetailsTab={pane.openDetailsTab}
      active={props.active}
      testID="terminal-selection-toolbar"
    />
  );
}
