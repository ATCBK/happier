import * as React from 'react';

import { WorkflowAgentDetail } from '@/components/workflows/presentation/WorkflowAgentDetail';

/**
 * What a Workflow published here, under its summary: the typed result when it says more than the summary
 * (the shared clamped result preview). Open run stays on the Run's own header under the asking message.
 */
export function DiscussionWorkflowResult(
  props: Readonly<{ messageId: string; detail: string | null }>,
) {
  return props.detail ? (
    <WorkflowAgentDetail
      text={props.detail}
      detailTestID={`session-discussion-workflow-result-${props.messageId}`}
    />
  ) : null;
}
