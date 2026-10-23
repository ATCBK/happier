import * as React from 'react';
import type { DiscussionAddressV1 } from '@happier-dev/protocol/discussions';
import type { WorkflowRunStartResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import { createWorkflowRunActionChip } from '@/components/sessions/agentInput/sessionActions/createWorkflowRunActionChip';
import { WorkflowStartPicker, type WorkflowStartSelection } from '@/components/workflows/run/WorkflowStartPicker';
import { useWorkflowComposerStart } from '@/components/workflows/run/useWorkflowComposerStart';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useDiscussionWorkflowCapture } from './useDiscussionWorkflowCapture';

/** Data binding only. The Discussion composition owner places this shared chip. */
export function useDiscussionWorkflowRun(params: Readonly<{
    discussion: DiscussionAddressV1;
    accountLifetime: ServerAccountScopeLifetime;
    /** A committed question, not a draft/local id. Admission reads its actual sequence. */
    addressingMessageId: string | null;
    /**
     * Called only on Run. The existing Discussion submit owner retains/rejoins this localId,
     * commits submittedDraft as ordinary unaddressed content (buildDiscussionContent(text, [])),
     * and resolves only its observed committed message. Do not reuse structured Ask addressing:
     * Workflow admission owns this Run, so posting must not also trigger ordinary U2 Ask fanout.
     */
    prepareAddressingMessage?: (request: Readonly<{ localId: string;
        inputs: Readonly<Record<string, JsonValue>> | undefined; retainedDraft: string; submittedDraft: string }>) => Promise<Readonly<{ messageId: string }>>;
    project: WorkflowProjectTargetV1 | null;
    readDraft: () => string;
    onStarted: (result: WorkflowRunStartResultV1) => void;
    disabled?: boolean;
}>) {
    const saveAsPattern = useDiscussionWorkflowCapture(params);
    const origin = React.useMemo(() => params.addressingMessageId === null ? undefined : {
        kind: 'discussion' as const, discussion: params.discussion, addressingMessageId: params.addressingMessageId,
    }, [params.addressingMessageId, params.discussion]);
    const onComplete = React.useMemo(() => ({ kind: 'originating_discussion' as const }), []);
    const prepareOrigin = React.useMemo(() => params.prepareAddressingMessage === undefined ? undefined
        : async (request: Readonly<{ runId: string; inputs: Readonly<Record<string, JsonValue>> | undefined;
            retainedDraft: string; submittedDraft: string }>) => {
            if (!params.accountLifetime.isCurrent()) throw new WorkflowActionError({ message: 'action_account_scope_changed', rawCode: 'action_account_scope_changed' });
            const committed = await params.prepareAddressingMessage!({ localId: request.runId,
                inputs: request.inputs, retainedDraft: request.retainedDraft, submittedDraft: request.submittedDraft });
            if (!params.accountLifetime.isCurrent()) throw new WorkflowActionError({ message: 'action_account_scope_changed', rawCode: 'action_account_scope_changed' });
            return { kind: 'discussion' as const, discussion: params.discussion, addressingMessageId: committed.messageId };
        }, [params.accountLifetime, params.discussion, params.prepareAddressingMessage]);
    const scoped = areServerProfileIdentifiersEquivalent(params.accountLifetime.scope.serverId, params.discussion.serverId);
    const start = useWorkflowComposerStart({ project: scoped && (origin || prepareOrigin) ? params.project : null, origin, onComplete,
        ...(origin ? {} : { prepareOrigin }),
        accountLifetime: params.accountLifetime, onStarted: params.onStarted });
    const readDraftRef = React.useRef(params.readDraft);
    readDraftRef.current = params.readDraft;
    const select = React.useCallback((selection: WorkflowStartSelection) => {
        start(selection, { retainedDraft: readDraftRef.current() });
    }, [start]);
    const chip = React.useMemo(() => createWorkflowRunActionChip({
        label: t('workflows.start.runPattern'), title: t('workflows.start.runPatternTitle'),
        testID: 'discussion-workflow-run-chip',
        disabled: params.disabled || !scoped || (origin === undefined && prepareOrigin === undefined) || params.project === null,
        renderContent: ({ requestClose, maxHeight }) => <WorkflowStartPicker
            accountLifetime={params.accountLifetime} onSelect={select} onRequestClose={requestClose} maxHeight={maxHeight} />,
    }), [origin, params.accountLifetime, params.disabled, params.project, prepareOrigin, scoped, select]);
    return { chip, select, saveAsPattern };
}
