import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { usePaneMainColumn } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import { AskSelectionControls } from '@/components/ui/code/selection/AskSelectionControls';
import { readCodeLineFromDomNode, resolveSourceLinesForText, useDomTextSelection } from '@/components/ui/code/selection/useDomTextSelection';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

/**
 * Ask about a selection in the File page's read bodies (lab AS1): the code view (rows know their file
 * line) and the Markdown preview (lines found in its source). The same controls as the editor's.
 */
export function FileReadAskControls(props: Readonly<{
    rootRef: React.RefObject<unknown>;
    mode: 'code' | 'markdown';
    scopeId: string;
    scope: WorkspaceScopeBase;
    filePath: string;
    text: string;
    sessionId: string | null;
    active: boolean;
}>): React.ReactElement | null {
    const pane = useAppPaneScope(props.scopeId);
    const mainColumn = usePaneMainColumn();
    const text = props.text;
    const resolveLines = React.useCallback((range: Parameters<Parameters<typeof useDomTextSelection>[0]['resolveLines']>[0]) => {
        if (props.mode === 'markdown') return resolveSourceLinesForText(text, range.text);
        const start = readCodeLineFromDomNode(range.startNode);
        const end = readCodeLineFromDomNode(range.endNode);
        return start === null || end === null ? null : { startLine: Math.min(start, end), endLine: Math.max(start, end) };
    }, [props.mode, text]);
    const source = useDomTextSelection({ rootRef: props.rootRef, active: props.active, resolveLines });
    const getLinesText = React.useCallback(() => text, [text]);
    const revealSessionColumn = React.useCallback(() => {
        if (mainColumn?.hidden) mainColumn.setHidden(false);
    }, [mainColumn]);
    const sessionTarget = React.useMemo(() => props.sessionId ? { sessionId: props.sessionId, revealSessionColumn } : null,
        [props.sessionId, revealSessionColumn]);
    return (
        <AskSelectionControls
            scopeId={props.scopeId}
            workspaceScope={props.scope}
            filePath={props.filePath}
            source={props.mode === 'markdown' ? 'markdown' : 'file'}
            sourceLinesMapped={props.mode === 'markdown'}
            getSelection={source.getSelection}
            subscribeSelection={source.subscribeSelection}
            getLinesText={getLinesText}
            savedText={text}
            sessionTarget={sessionTarget}
            openDetailsTab={pane.openDetailsTab}
            active={props.active}
            testID="file-read-selection-toolbar"
        />
    );
}
