import * as React from 'react';
import type {
    SessionDraftAddressV2,
    StrictJsonValue,
} from '@happier-dev/protocol';
import { canonicalSessionDraftAddressV2, DiscussionDraftDocumentV2Schema, type DiscussionDraftSubmittedContentV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import type { DiscussionMessageContentV1 } from '@happier-dev/protocol/discussions/content';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    captureSessionDraftCurrentness,
    clearSessionDraftCurrentnessLocal,
    flushSessionDraft,
    flushSessionDraftLocally,
    getSessionComposerDraftSnapshot,
    getSessionDraftSnapshot,
    purgeSessionDraftPresentation,
    subscribeSessionDraft,
    writeDiscussionSessionDraft,
    writeSessionDraftLocalSupplement,
    type SessionDiscussionDraftMutationAttempt,
    type SessionDiscussionDraftMutationAttemptInput,
    type SessionDraftConflict,
    type SessionDraftStatus,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { DiscussionDraftSubmission } from '@/sync/ops/discussions/discussionRepository';

import {
    parseDiscussionMentionSpans,
    prepareDiscussionContentForPassage,
    buildDiscussionContent,
    resolveDiscussionCreationTitle,
    reconcileDiscussionMentionSpans,
    type DiscussionMentionSpan,
} from './discussionComposerDocument';

export type DiscussionDraftAddress = Extract<
    SessionDraftAddressV2,
    { kind: 'discussion' | 'newDiscussion' }
>;

export type DiscussionDraft = Readonly<{
    title: string;
    text: string;
    mentions: readonly DiscussionMentionSpan[];
    passage: DocPassageRefV1 | null;
    submitted: DiscussionDraftSubmittedContentV2 | null;
    setPassage(passage: DocPassageRefV1 | null): void;
    prepareContent(content: DiscussionMessageContentV1): DiscussionMessageContentV1;
    status: SessionDraftStatus;
    conflict: SessionDraftConflict | null;
    setTitle(title: string): void;
    setText(text: string): void;
    setMentions(mentions: readonly DiscussionMentionSpan[]): void;
    setComposer(value: Readonly<{
        text: string;
        mentions: readonly DiscussionMentionSpan[];
    }>): void;
    pendingMutationAttempt: SessionDiscussionDraftMutationAttempt | null;
    captureSubmittedCurrentness(attempt?: SessionDiscussionDraftMutationAttemptInput,
        submitted?: Readonly<{ content: DiscussionMessageContentV1; title?: string }>): DiscussionDraftSubmission;
    clearAfterObservedSuccess(submission: DiscussionDraftSubmission): Promise<boolean>;
    /**
     * Forgets a refused retry identity without touching the drafted fields, so
     * a remount adopts nothing and the retained text is sent as a fresh attempt.
     */
    releaseSubmittedAttempt(): void;
    purgePresentation(): Promise<void>;
    purgeSourcePresentation(): Promise<void>;
}>;

const COMPOSER_FIELD_IDS = ['composer.text', 'composer.mentions', 'passage', 'submission'] as const;
const NEW_DISCUSSION_FIELD_IDS = [...COMPOSER_FIELD_IDS, 'title'] as const;

function readDiscussionComposerSnapshot(scope: ServerAccountScope, address: DiscussionDraftAddress) {
    const snapshot = getSessionComposerDraftSnapshot(scope, address);
    return snapshot?.targetKind === address.kind ? snapshot : null;
}

function readDiscussionDraftFields(
    scope: ServerAccountScope,
    address: DiscussionDraftAddress,
): Readonly<{
    title: string;
    text: string;
    mentions: readonly DiscussionMentionSpan[];
    passage: DocPassageRefV1 | null;
    submitted: DiscussionDraftSubmittedContentV2 | null;
}> {
    const snapshot = readDiscussionComposerSnapshot(scope, address);
    const parsedDocument = DiscussionDraftDocumentV2Schema.safeParse(getSessionDraftSnapshot(scope, address)?.document);
    const document = parsedDocument.success ? parsedDocument.data : null;
    const text = typeof snapshot?.composer.text.value === 'string'
        ? snapshot.composer.text.value
        : '';
    return {
        title: address.kind === 'newDiscussion'
            && document?.target.kind === 'newDiscussion'
            && document.title
            && typeof document.title.value === 'string'
            ? document.title.value
            : '',
        text,
        mentions: parseDiscussionMentionSpans(snapshot?.composer.mentions.value, text),
        passage: document?.passage?.value ?? null,
        submitted: document?.submission?.value ?? null,
    };
}

function mentionValues(mentions: readonly DiscussionMentionSpan[]): readonly StrictJsonValue[] {
    return mentions.map((mention) => ({
        start: mention.start,
        end: mention.end,
        ...(typeof mention.accountId === 'string' ? { accountId: mention.accountId }
            : typeof mention.sessionId === 'string' ? { sessionId: mention.sessionId } : { participantSlotId: mention.participantSlotId }),
    }));
}

function sameAddress(left: DiscussionDraftAddress, right: DiscussionDraftAddress): boolean {
    return canonicalSessionDraftAddressV2(left) === canonicalSessionDraftAddressV2(right);
}

function sameScope(left: ServerAccountScope, right: ServerAccountScope): boolean {
    return left.serverId === right.serverId && left.accountId === right.accountId;
}

/**
 * An explicit "Ask <person>" from elsewhere in the app: fills an empty new Discussion with an addressed
 * request the person still reads and sends. Words already in that draft are never replaced.
 */
export function seedNewDiscussionDraft(input: Readonly<{
    scope: ServerAccountScope;
    title: string;
    text: string;
    mentions: readonly DiscussionMentionSpan[];
}>): boolean {
    const address: DiscussionDraftAddress = { kind: 'newDiscussion' };
    const current = readDiscussionDraftFields(input.scope, address);
    if (current.text.trim() || current.title.trim()) return false;
    writeDiscussionSessionDraft({
        scope: input.scope,
        address,
        patch: { title: input.title, text: input.text, mentions: mentionValues(parseDiscussionMentionSpans(input.mentions, input.text)) },
    });
    return true;
}

/**
 * React projection over the synchronized V2 draft repository. This hook owns
 * no persistence, retry queue or draft lifecycle; desktop and mobile consumers
 * therefore observe the same exact Home/Account/address document.
 */
export function useDiscussionDraft(params: Readonly<{
    scope: ServerAccountScope;
    address: DiscussionDraftAddress;
}>): DiscussionDraft {
    const scope = React.useMemo<ServerAccountScope>(() => ({
        serverId: params.scope.serverId,
        accountId: params.scope.accountId,
    }), [params.scope.accountId, params.scope.serverId]);
    const addressKey = canonicalSessionDraftAddressV2(params.address);
    const address = React.useMemo<DiscussionDraftAddress>(() => params.address, [addressKey]);
    const subscribe = React.useCallback(
        (listener: () => void) => subscribeSessionDraft(scope, address, listener),
        [address, scope],
    );
    const readSnapshot = React.useCallback(
        () => readDiscussionComposerSnapshot(scope, address),
        [address, scope],
    );
    const snapshot = React.useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
    const fields = readDiscussionDraftFields(scope, address);
    const text = fields.text;
    const mentions = React.useMemo(
        () => parseDiscussionMentionSpans(snapshot?.composer.mentions.value, text),
        [snapshot?.composer.mentions.value, text],
    );
    const title = fields.title;
    const passage = fields.passage;
    const attempt = snapshot?.localSupplement.discussionMutationAttempt;
    const attemptLocalId = attempt?.kind === 'create' ? attempt.creationLocalId : attempt?.localId;
    const submitted = attemptLocalId && fields.submitted?.attemptLocalId === attemptLocalId ? fields.submitted : null;
    const setPassage = React.useCallback((value: DocPassageRefV1 | null) => {
        writeDiscussionSessionDraft({ scope, address, patch: { passage: value } });
    }, [address, scope]);
    const prepareContent = React.useCallback((content: DiscussionMessageContentV1): DiscussionMessageContentV1 => {
        const basis = readDiscussionDraftFields(scope, address).passage;
        return prepareDiscussionContentForPassage({ content, passage: basis });
    }, [address, scope]);

    const setComposer = React.useCallback((value: Readonly<{
        text: string;
        mentions: readonly DiscussionMentionSpan[];
    }>) => {
        writeDiscussionSessionDraft({
            scope,
            address,
            patch: {
                text: value.text,
                mentions: mentionValues(parseDiscussionMentionSpans(value.mentions, value.text)),
            },
        });
    }, [address, scope]);

    const setText = React.useCallback((nextText: string) => {
        const current = readDiscussionDraftFields(scope, address);
        writeDiscussionSessionDraft({
            scope,
            address,
            patch: {
                text: nextText,
                mentions: mentionValues(reconcileDiscussionMentionSpans({
                    previousText: current.text,
                    nextText,
                    mentions: current.mentions,
                })),
            },
        });
    }, [address, scope]);

    const setMentions = React.useCallback((nextMentions: readonly DiscussionMentionSpan[]) => {
        const currentText = readDiscussionDraftFields(scope, address).text;
        writeDiscussionSessionDraft({
            scope,
            address,
            patch: { mentions: mentionValues(parseDiscussionMentionSpans(nextMentions, currentText)) },
        });
    }, [address, scope]);

    const setTitle = React.useCallback((nextTitle: string) => {
        if (address.kind !== 'newDiscussion') {
            throw new Error('An existing discussion title is changed through the rename Action');
        }
        writeDiscussionSessionDraft({ scope, address, patch: { title: nextTitle } });
    }, [address, scope]);

    const captureSubmittedCurrentness = React.useCallback((attempt?: SessionDiscussionDraftMutationAttemptInput,
        submitted?: Readonly<{ content: DiscussionMessageContentV1; title?: string }>): DiscussionDraftSubmission => {
        if (attempt) {
            const current = readDiscussionDraftFields(scope, address);
            const content = submitted?.content ?? prepareDiscussionContentForPassage({ content: buildDiscussionContent(current.text, current.mentions), passage: current.passage });
            const title = attempt.kind === 'create' ? submitted?.title ?? resolveDiscussionCreationTitle({ title: current.title, text: current.text }) ?? undefined : undefined;
            writeDiscussionSessionDraft({ scope, address, patch: { submission: {
                attemptLocalId: attempt.kind === 'create' ? attempt.creationLocalId : attempt.localId,
                content, ...(title === undefined ? {} : { title }),
            } } });
        }
        const currentness = captureSessionDraftCurrentness({
            scope,
            address,
            fieldIds: address.kind === 'newDiscussion'
                ? [...NEW_DISCUSSION_FIELD_IDS]
                : [...COMPOSER_FIELD_IDS],
        });
        if (attempt) {
            writeSessionDraftLocalSupplement({
                scope,
                address,
                patch: { discussionMutationAttempt: { ...attempt, currentness } as SessionDiscussionDraftMutationAttempt },
            });
        }
        return {
            scope,
            address,
            currentness,
        };
    }, [address, scope]);

    const clearAfterObservedSuccess = React.useCallback(async (
        submission: DiscussionDraftSubmission,
    ): Promise<boolean> => {
        if (!sameScope(submission.scope, scope) || !sameAddress(submission.address, address)) return false;
        const current = captureSessionDraftCurrentness({
            scope,
            address,
            fieldIds: address.kind === 'newDiscussion'
                ? [...NEW_DISCUSSION_FIELD_IDS]
                : [...COMPOSER_FIELD_IDS],
        });
        const capturedText = submission.currentness.mutationIds['composer.text'];
        const capturedMentions = submission.currentness.mutationIds['composer.mentions'];
        const composerIsCurrent = capturedText !== undefined
            && capturedMentions !== undefined
            && current.mutationIds['composer.text'] === capturedText
            && current.mutationIds['composer.mentions'] === capturedMentions;
        const titleIsCurrent = address.kind === 'newDiscussion'
            && submission.currentness.mutationIds.title !== undefined
            && current.mutationIds.title === submission.currentness.mutationIds.title;
        const fieldIds = [
            ...(composerIsCurrent ? COMPOSER_FIELD_IDS : []),
            ...(!composerIsCurrent ? ['submission' as const] : []),
            ...(titleIsCurrent ? ['title' as const] : []),
        ];
        // Field currentness decides which drafted fields are cleared, never
        // whether the attempt is retired. The attempt identifies a submission
        // the server already accepted, so once every captured field has moved
        // on there is nothing to clear and the identity must still go — keeping
        // it would let a remount adopt an accepted create/post and repeat it.
        // Local recovery custody must complete before navigation; a remote
        // draft acknowledgement cannot hold an already committed Discussion open.
        const cleared = fieldIds.length === 0
            ? false
            : clearSessionDraftCurrentnessLocal({
                scope,
                address,
                currentness: submission.currentness,
                fieldIds,
            });
        writeSessionDraftLocalSupplement({ scope, address, patch: { discussionMutationAttempt: null } });
        await flushSessionDraftLocally({ scope });
        // The canonical draft synchronizer retains the pending clear on failure.
        // It is independent of opening the committed resource.
        void flushSessionDraft({ scope, address }).catch(() => undefined);
        return cleared;
    }, [address, scope]);

    const releaseSubmittedAttempt = React.useCallback((): void => {
        writeDiscussionSessionDraft({ scope, address, patch: { submission: null } });
        writeSessionDraftLocalSupplement({ scope, address, patch: { discussionMutationAttempt: null } });
    }, [address, scope]);

    const purgePresentation = React.useCallback(async (): Promise<void> => {
        await purgeSessionDraftPresentation({ scope, address });
    }, [address, scope]);
    const purgeSourcePresentation = React.useCallback(async (): Promise<void> => {
        await purgeSessionDraftPresentation({ scope, address, fieldIds: ['passage', 'submission'] });
    }, [address, scope]);

    return React.useMemo(() => ({
        title,
        text,
        mentions,
        passage,
        submitted,
        setPassage,
        prepareContent,
        pendingMutationAttempt: snapshot?.localSupplement.discussionMutationAttempt ?? null,
        status: snapshot?.status ?? 'clean',
        conflict: snapshot?.conflict ?? null,
        setTitle,
        setText,
        setMentions,
        setComposer,
        captureSubmittedCurrentness,
        clearAfterObservedSuccess,
        releaseSubmittedAttempt,
        purgePresentation,
        purgeSourcePresentation,
    }), [
        captureSubmittedCurrentness,
        clearAfterObservedSuccess,
        releaseSubmittedAttempt,
        purgePresentation,
        purgeSourcePresentation,
        mentions,
        passage,
        submitted,
        setPassage,
        prepareContent,
        snapshot?.localSupplement.discussionMutationAttempt,
        setComposer,
        setMentions,
        setText,
        setTitle,
        snapshot?.conflict,
        snapshot?.status,
        text,
        title,
    ]);
}
