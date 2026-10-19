import * as React from 'react';
import { View } from 'react-native';

import { SessionBoardDeclarativeContent } from '@/components/sessions/board/SessionBoardDeclarativeContent';
import { resolveSessionBoardReplyHeight } from '@/components/sessions/board/sessionBoardItemHeight';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { HostedHtmlSurfaceAdapter } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import { useSessionCallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/useSessionCallerHostedHtmlRuntime';
import { t } from '@/text';

import type { ApprovalVisualPreview as ApprovalVisualPreviewValue } from './approvalFieldValues';

type PreviewProps = Readonly<{
    preview: ApprovalVisualPreviewValue;
    artifactId: string;
    serverId: string | null;
    testID: string;
}>;

/**
 * The visual a person is asked to approve, drawn by the same owners as the reply, in its own row of
 * the request. Typed content renders inert; HTML runs in the shared sandboxed frame with no network
 * and nothing granted, because nothing is approved yet.
 */
export function ApprovalVisualPreview(props: PreviewProps): React.ReactElement | null {
    if (props.preview.kind === 'declarative') {
        return (
            <SectionContentRow testID={`${props.testID}-row`}>
                <SessionBoardDeclarativeContent testID={props.testID} document={props.preview.document} actionBinding={null} />
            </SectionContentRow>
        );
    }
    return <ApprovalHtmlPreview key={props.artifactId} {...props} preview={props.preview} />;
}

function ApprovalHtmlPreview(props: PreviewProps & Readonly<{
    preview: Extract<ApprovalVisualPreviewValue, { kind: 'html' }>;
}>): React.ReactElement | null {
    // The approval carries the content, so the preview needs no readable Session, and without a
    // plugin runtime it admits no Actions or Resources: presentation only.
    const runtime = useSessionCallerHostedHtmlRuntime(props.serverId, undefined);
    const [reportedHeight, setReportedHeight] = React.useState<number>();
    // The request already carries the visual, so reserve its declared footprint before
    // the Account/runtime resolves, through the same height owner as the reply.
    const height = resolveSessionBoardReplyHeight({
        height: props.preview.height ?? { mode: 'auto', fallback: 'regular' },
        reportedHeight,
        measuresIntrinsicHeight: true,
    })!.height;
    return (
        <SectionContentRow testID={`${props.testID}-row`}>
            <View testID={props.testID} style={{ height }}>
                {runtime ? <HostedHtmlSurfaceAdapter
                    title={props.preview.title ?? t('sessionBoard.item.untitled')}
                    recordRevision={props.artifactId}
                    approvalSubject={`approval-preview:${props.artifactId}`}
                    source={props.preview.source}
                    requestedCapabilities={props.preview.requestedCapabilities}
                    target={{ kind: 'app' }}
                    runtime={runtime}
                    onIntrinsicHeightChange={setReportedHeight}
                    testID={`${props.testID}-hosted-html`}
                /> : null}
            </View>
        </SectionContentRow>
    );
}
