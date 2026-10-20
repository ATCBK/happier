import * as React from 'react';

import { buildSessionDetailsHref } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { useTranscriptFileLinks } from '@/components/sessions/transcript/useTranscriptFileLinks';
import type { ReviewCommentAnchor } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

import { TurnChangesCard } from './TurnChangesCard';

export type TranscriptTurnChangesCardProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    turnId: string;
    files: readonly ScmFileStatus[];
    firstHunkAnchors?: Readonly<Record<string, ReviewCommentAnchor>>;
    messageId?: string;
    /** Public/read-only sources cannot open private workspace files. */
    fileOpenEnabled?: boolean;
}>;

/**
 * The turn-end card in the transcript (WT9-R): the turn's own Diff evidence, opening Files on exactly
 * this turn's comparison. Both entrances keep the turn identity even after the working copy changes.
 */
export const TranscriptTurnChangesCard = React.memo(function TranscriptTurnChangesCard(props: TranscriptTurnChangesCardProps) {
    const source = useSessionTranscriptSource();
    const rootPath = source.useWorkspacePath();
    const navigate = source.navigate;
    const canOpen = props.fileOpenEnabled === true;
    const { openPath } = useTranscriptFileLinks({
        sessionId: props.sessionId, serverId: props.serverId,
        workspacePath: rootPath, canOpenFiles: canOpen, routeMessageId: props.messageId,
    });
    const openInFiles = React.useMemo(() => {
        if (!navigate || !canOpen) return null;
        const href = buildSessionDetailsHref({
            sessionId: props.sessionId,
            serverId: props.serverId ?? null,
            details: { kind: 'scmReview', comparison: { kind: 'turnCheckpoint', turnId: props.turnId }, view: 'files' },
        });
        return () => navigate(href);
    }, [canOpen, navigate, props.serverId, props.sessionId, props.turnId]);
    const workspace = React.useMemo(() => ({ serverId: props.serverId ?? null, rootPath }), [props.serverId, rootPath]);
    const openFile = React.useCallback((path: string) => {
        const anchor = props.firstHunkAnchors?.[path];
        openPath(path, { view: 'changes', changesScope: { kind: 'turn', turnId: props.turnId },
            ...(anchor ? { anchor, anchorSource: 'diff' } : {}) });
    }, [openPath, props.firstHunkAnchors, props.turnId]);
    const walkThrough = React.useMemo(() => {
        if (!navigate || !canOpen) return null;
        const href = buildSessionDetailsHref({
            sessionId: props.sessionId, serverId: props.serverId ?? null,
            details: { kind: 'scmReview', comparison: { kind: 'turnCheckpoint', turnId: props.turnId }, view: 'walkthrough' },
        });
        return () => navigate(href);
    }, [canOpen, navigate, props.serverId, props.sessionId, props.turnId]);
    return (
        <TurnChangesCard
            testID={`turn-changes-card:${props.turnId}`}
            files={props.files}
            messageId={props.messageId}
            workspace={workspace}
            onOpenFile={openFile}
            onOpenInFiles={openInFiles}
            onWalkThrough={walkThrough}
        />
    );
});
