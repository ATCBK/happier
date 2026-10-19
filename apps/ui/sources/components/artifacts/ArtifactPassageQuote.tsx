import * as React from 'react';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';

import { ReplyQuote } from '@/components/ui/text/ReplyQuote';
import { t } from '@/text';

/** The passage is opened by the existing Doc/Discussion owner before reaching presentation. */
export function ArtifactPassageQuote(props: Readonly<{ testID?: string; passage: DocPassageRefV1 | null }>) {
    return <ReplyQuote testID={props.testID} kind="doc_passage" source={props.passage
        ? { state: 'available', label: t('session.collaboration.discussion.quote.document'), text: props.passage.quote,
            detail: t('session.collaboration.discussion.quote.revision', props.passage.revision) }
        : { state: 'unavailable', label: t('session.collaboration.discussion.quote.document'),
            reason: t('session.collaboration.discussion.quote.unavailable') }} />;
}
