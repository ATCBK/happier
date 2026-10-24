import type { DiscussionCreateResultV1 } from '@happier-dev/protocol/discussions/actions';
import { DiscussionSecondOpinionStartInputV1Schema, type DiscussionSecondOpinionStartInputV1, type DiscussionSecondOpinionStartResultV1 } from '@happier-dev/protocol/discussions/secondOpinionActions';
import { prepareAnchoredDiscussionCreateV1 } from '@happier-dev/protocol/actions/executor/discussionSecondOpinion';
import { createDiscussionClient, type DiscussionClientOutcome } from '@/sync/api/discussions/discussionActions';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { randomUUID } from '@/platform/randomUUID';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import type { ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';

type Draft = Pick<DiscussionSecondOpinionStartInputV1, 'title' | 'question' | 'reviewers' | 'participants'>;
type Preview = Extract<DiscussionSecondOpinionStartResultV1, { status: 'preview' }>;
type Result = Readonly<{ operation: 'second_opinion'; outcome: DiscussionClientOutcome<DiscussionSecondOpinionStartResultV1> }>
    | Readonly<{ operation: 'discuss'; outcome: DiscussionClientOutcome<DiscussionCreateResultV1> }>;
export type DiscussionSecondOpinionSnapshot = Readonly<{
    source: DiscussionSecondOpinionStartInputV1['source'];
    draft: Draft;
    retry: DiscussionSecondOpinionStartInputV1['retry'];
    preview: Preview | null;
    result: Result | null;
    working: boolean;
    submitted: boolean;
    discussionMessage: DiscussionMessageRefV1 | null;
    /** Asking several starts Fresh opinions; this is that Run. */
    runHref: string | null;
}>;

/** L7's retained draft only; every effect stays at the captured-Home Action owner. */
export function createDiscussionSecondOpinionController(options: Readonly<{
    scope: ServerAccountScope;
    availability: SessionCollaborationAvailability;
    source: DiscussionSecondOpinionStartInputV1['source'];
    draft: Draft;
}>) {
    const client = createDiscussionClient(options);
    let snapshot: DiscussionSecondOpinionSnapshot = {
        source: options.source, draft: options.draft,
        retry: { creationLocalId: randomUUID(), quoteLocalId: randomUUID(), questionLocalId: randomUUID() },
        preview: null, result: null, working: false, submitted: false, discussionMessage: null, runHref: null,
    };
    const listeners = new Set<() => void>();
    const publish = (patch: Partial<DiscussionSecondOpinionSnapshot>) => {
        snapshot = { ...snapshot, ...patch };
        for (const listener of listeners) listener();
    };
    let retainedAsk: DiscussionSecondOpinionStartInputV1 | null = null;
    let retainedDiscuss: Parameters<typeof client.create>[0] | null = null;
    const applyAsk = (outcome: DiscussionClientOutcome<DiscussionSecondOpinionStartResultV1>) => {
        const value = outcome.kind === 'succeeded' ? outcome.value : null;
        publish({ working: false, result: { operation: 'second_opinion', outcome },
            ...(value?.status === 'preview' ? { preview: value } : {}),
            ...(value?.status === 'preview_changed' && snapshot.preview
                ? { preview: { ...snapshot.preview, preview: value.preview } } : {}),
            ...(value?.status === 'asked' ? { discussionMessage: value.messageRef,
                runHref: value.runId ? createWorkflowRunRoute(value.runId, value.discussion.serverId) : null } : {}),
        });
        return outcome;
    };
    const runAsk = async (input: DiscussionSecondOpinionStartInputV1, signal?: AbortSignal) => {
        publish({ working: true });
        return applyAsk(await client.secondOpinion(input, signal));
    };
    const runDiscuss = async (input: Parameters<typeof client.create>[0], signal?: AbortSignal) => {
        publish({ working: true });
        const outcome = await client.create(input, signal);
        publish({ working: false, result: { operation: 'discuss', outcome },
            ...(outcome.kind === 'succeeded' ? { discussionMessage: outcome.value.firstMessage.messageRef } : {}) });
        return outcome;
    };
    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        updateDraft(draft: Draft): boolean {
            if (snapshot.submitted) return false;
            publish({ draft, preview: null, result: null });
            return true;
        },
        toggleReviewer(selection: ExecutableParticipantSelectionV1, question: string): boolean {
            if (snapshot.working || snapshot.submitted) return false;
            const selected = snapshot.draft.reviewers.some(reviewer => sameStrictJsonValue(reviewer.selection, selection));
            const reviewers = selected
                ? snapshot.draft.reviewers.filter(reviewer => !sameStrictJsonValue(reviewer.selection, selection))
                : [...snapshot.draft.reviewers, { selection,
                    ...(selection.kind === 'model' ? { participantSlotId: randomUUID() } : {}) }];
            publish({ draft: { ...snapshot.draft, question, reviewers }, preview: null, result: null });
            return true;
        },
        async preview(signal?: AbortSignal) {
            if (snapshot.working || snapshot.submitted) return;
            const draft = snapshot.draft;
            publish({ working: true });
            const outcome = await client.secondOpinion({ ...draft, source: snapshot.source, retry: snapshot.retry, intent: 'preview' }, signal);
            if (snapshot.draft !== draft) { publish({ working: false }); return outcome; }
            return applyAsk(outcome);
        },
        /** Asking several starts Fresh opinions, which runs where `project` says; one reviewer needs no placement. */
        async ask(options: Readonly<{ project?: WorkflowProjectTargetV1 | null; signal?: AbortSignal }> = {}) {
            if (snapshot.working || !snapshot.preview || retainedDiscuss) return;
            const project = snapshot.draft.reviewers.length > 1 ? options.project ?? undefined : undefined;
            retainedAsk = DiscussionSecondOpinionStartInputV1Schema.parse({ ...snapshot.draft, source: snapshot.source, retry: snapshot.retry,
                intent: 'ask', confirmedPreview: snapshot.preview.preview, ...(project ? { project } : {}) });
            publish({ submitted: true });
            return runAsk(retainedAsk, options.signal);
        },
        async discuss(signal?: AbortSignal) {
            if (snapshot.working || !snapshot.preview || retainedAsk || snapshot.draft.reviewers.length !== 0) return;
            const prepared = prepareAnchoredDiscussionCreateV1({ source: snapshot.source, title: snapshot.draft.title,
                quote: snapshot.preview.sourceText, creationLocalId: snapshot.retry.creationLocalId,
                quoteLocalId: snapshot.retry.quoteLocalId, participants: snapshot.draft.participants });
            // Machine-local attachment sources belong to Agent posts; this composer stages uploads itself.
            const { firstMessage, attachmentSources: _machineSources, ...creation } = prepared;
            retainedDiscuss = { ...creation, messageLocalId: snapshot.retry.quoteLocalId, content: firstMessage.content,
                replyTarget: prepared.firstMessage.replyTarget };
            publish({ submitted: true });
            return runDiscuss(retainedDiscuss, signal);
        },
        async retry(signal?: AbortSignal) {
            if (snapshot.working) return;
            if (snapshot.result?.operation === 'second_opinion' && snapshot.result.outcome.kind === 'succeeded'
                && snapshot.result.outcome.value.status === 'preview_changed') return;
            if (retainedAsk) return runAsk(retainedAsk, signal);
            if (retainedDiscuss) return runDiscuss(retainedDiscuss, signal);
        },
    };
}
