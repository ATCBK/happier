import * as React from 'react';
import { Platform } from 'react-native';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { usePaneMainColumn } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import { AskSelectionControls } from '@/components/ui/code/selection/AskSelectionControls';
import type { AskSelection } from '@/components/ui/code/selection/useAskSelection';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';

import { buildChatListNativeId } from '../chatListNativeId';

type DomNode = Readonly<{
  parentElement?: DomElement | null;
  nodeType?: number;
}>;
type DomElement = DomNode &
  Readonly<{
    id?: string;
    dataset?: Readonly<Record<string, string | undefined>>;
  }>;

function closestElement(
  node: DomNode | null | undefined,
  matches: (element: DomElement) => boolean,
): DomElement | null {
  let element: DomElement | null | undefined =
    node && node.nodeType === 1 ? (node as DomElement) : node?.parentElement;
  while (element) {
    if (matches(element)) return element;
    element = element.parentElement;
  }
  return null;
}

/**
 * Ask about a selection inside a code block of this Session's transcript (web, lab AS1): the fenced
 * quote goes to this Session's composer through the canonical append. One instance per Session view.
 */
export function TranscriptCodeAskControls(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    scopeId: string;
    active: boolean;
  }>,
): React.ReactElement | null {
  const workspaceScope = useWorkspaceScopeForSession(
    Platform.OS === 'web' ? props.sessionId : '',
    props.serverId,
  );
  if (Platform.OS !== 'web' || !workspaceScope) return null;
  return (
    <TranscriptCodeAskControlsContent
      {...props}
      workspaceScope={workspaceScope}
    />
  );
}

function TranscriptCodeAskControlsContent(
  props: Readonly<{
    sessionId: string;
    scopeId: string;
    active: boolean;
    workspaceScope: NonNullable<ReturnType<typeof useWorkspaceScopeForSession>>;
  }>,
): React.ReactElement {
  const pane = useAppPaneScope(props.scopeId);
  const mainColumn = usePaneMainColumn();
  // The transcript list's DOM id starts with this prefix (`buildChatListNativeId`).
  const listIdPrefix = buildChatListNativeId(props.sessionId, '').replace(
    /instance$/u,
    '',
  );
  const getSelection = React.useCallback((): AskSelection | null => {
    if (typeof window === 'undefined') return null;
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
      return null;
    const range = selection.getRangeAt(0);
    const isBlock = (element: DomElement) =>
      element.dataset?.happierCodeBlock === 'true';
    const block = closestElement(range.startContainer as DomNode, isBlock);
    if (
      !block ||
      block !== closestElement(range.endContainer as DomNode, isBlock)
    )
      return null;
    if (
      !closestElement(
        block,
        (element) =>
          typeof element.id === 'string' && element.id.startsWith(listIdPrefix),
      )
    )
      return null;
    const text = selection.toString();
    if (text.trim().length === 0) return null;
    const start =
      Array.from(range.getClientRects()).find(
        (box) => box.width > 0 && box.height > 0,
      ) ?? range.getBoundingClientRect();
    return {
      startLine: 1,
      endLine: text.split('\n').length,
      text,
      rect: {
        x: start.left,
        y: start.top,
        width: start.width,
        height: start.height,
      },
    };
  }, [listIdPrefix]);
  const subscribeSelection = React.useCallback((listener: () => void) => {
    document.addEventListener('selectionchange', listener);
    return () => document.removeEventListener('selectionchange', listener);
  }, []);
  const revealSessionColumn = React.useCallback(() => {
    if (mainColumn?.hidden) mainColumn.setHidden(false);
  }, [mainColumn]);
  const sessionTarget = React.useMemo(
    () => ({ sessionId: props.sessionId, revealSessionColumn }),
    [props.sessionId, revealSessionColumn],
  );
  return (
    <AskSelectionControls
      scopeId={props.scopeId}
      workspaceScope={props.workspaceScope}
      source="transcript"
      getSelection={getSelection}
      subscribeSelection={subscribeSelection}
      sessionTarget={sessionTarget}
      openDetailsTab={pane.openDetailsTab}
      active={props.active}
      testID="transcript-code-selection-toolbar"
    />
  );
}
